import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import { basename, resolve } from "node:path";
import { hashValue } from "../provenance.js";
import type { WorkbenchGateClass, WorkbenchRunEstimate } from "../workbench/transition-policy.js";
import type {
	WorkbenchConfirmation,
	WorkbenchConfirmationKind,
	WorkbenchHumanGate,
} from "../workbench/types.js";

/**
 * The consequential gate, served to an authenticated operator over loopback.
 *
 * This is a *transport* for the same `WorkbenchHumanGate` the local TUI
 * implements, never an exemption from it. Nothing here approves anything: a
 * confirmation the Workbench raises becomes a pending record with the exact
 * host-minted subject hash, and it stays pending — the decision blocked behind
 * it — until the operator answers that exact id with that exact hash. A
 * mismatched hash, an unknown id, a replay, an expiry and a shutdown are all
 * refusals; none of them can become an approval.
 */

/** Seconds a pending confirmation waits before it becomes a refusal. */
export const DEFAULT_CONFIRMATION_TIMEOUT_SECONDS = 600;
export const MIN_CONFIRMATION_TIMEOUT_SECONDS = 1;
export const MAX_CONFIRMATION_TIMEOUT_SECONDS = 3_600;
/** Simultaneously open confirmations; the next one fails closed. */
export const MAX_OPEN_CONFIRMATIONS = 4;
/** How many settled ids are remembered so a replay is refused as settled, not unknown. */
const MAX_REMEMBERED_SETTLEMENTS = 256;

const CONFIRMATION_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;

export function isServeConfirmationId(value: string): boolean {
	return CONFIRMATION_ID_PATTERN.test(value);
}

/** Decision kinds plus the one host-owned choice that is not a decision. */
export type ServeConfirmationKind = WorkbenchConfirmationKind | "select-sealed";

export type ServeConfirmationSettlement =
	| "approved"
	| "declined"
	| "expired"
	| "subject-changed"
	| "server-closed"
	| "aborted";

/** Exactly what the platform's confirmation UI renders. Carries no credential. */
export interface ServeConfirmationProjection {
	confirmationId: string;
	operationId: string;
	kind: ServeConfirmationKind;
	title: string;
	reason: string;
	question: string;
	subject: unknown;
	subjectHash: string;
	policy: WorkbenchGateClass;
	estimate?: WorkbenchRunEstimate;
	/** Present exactly for a sealed-holdout selection; labels are host-owned. */
	options?: readonly { label: string; taskCount: number }[];
	openedAt: string;
	expiresAt: string;
}

export interface ServeConfirmationAnswer {
	approved: boolean;
	/** Must equal the pending confirmation's exact host-minted subject hash. */
	subjectHash: string;
	/** Required exactly for a sealed-holdout selection that was approved. */
	selectedIndex?: number;
}

export type ServeConfirmationAnswerResult =
	| { outcome: "recorded"; confirmation: ServeConfirmationProjection; approved: boolean }
	| { outcome: "unknown" }
	| { outcome: "already-settled"; settlement: ServeConfirmationSettlement }
	| { outcome: "subject-changed"; expected: string }
	| { outcome: "invalid"; message: string };

interface GateAnswer {
	approved: boolean;
	selectedIndex?: number;
}

interface PendingRecord {
	projection: ServeConfirmationProjection;
	operation: OperationState;
	settle: (settlement: ServeConfirmationSettlement, answer: GateAnswer) => void;
	settled: boolean;
}

interface OperationState {
	operationId: string;
	opened: PendingRecord[];
	waiters: Set<(record: PendingRecord) => void>;
}

/** One decide call in flight, with the gate that belongs to it. */
export interface ServeOperation {
	readonly operationId: string;
	readonly gate: WorkbenchHumanGate;
	/**
	 * The next confirmation this operation opened after `seen`, or null once
	 * `finished` settles first. `finished` always settles, so nothing leaks.
	 */
	nextConfirmation(seen: number, finished: Promise<unknown>): Promise<ServeConfirmationProjection | null>;
	/** How many confirmations this operation has opened so far. */
	openedCount(): number;
	/** Refuse anything still pending for this operation and forget it. */
	dispose(): void;
}

export interface ServeConfirmationRegistryOptions {
	/** Host-owned operator identity. Never read from a request. */
	actorId: string;
	timeoutSeconds?: number;
	now?: () => string;
	/** Observational hook for the event stream; a throw here changes nothing. */
	onOpened?: (confirmation: ServeConfirmationProjection) => void;
	onClosed?: (
		confirmation: ServeConfirmationProjection,
		settlement: ServeConfirmationSettlement,
	) => void;
}

export interface ServeConfirmationRegistry {
	beginOperation(): ServeOperation;
	/** Pending confirmations, oldest first — the order an operator answers them. */
	pending(): ServeConfirmationProjection[];
	find(confirmationId: string): ServeConfirmationProjection | null;
	answer(confirmationId: string, answer: ServeConfirmationAnswer): ServeConfirmationAnswerResult;
	/** Refuse everything still pending. Shutdown is a refusal, never an approval. */
	close(): void;
}

/** Bounded timeout, in milliseconds, from the operator-supplied seconds. */
export function confirmationTimeoutMs(seconds: number | undefined): number {
	const requested = seconds ?? DEFAULT_CONFIRMATION_TIMEOUT_SECONDS;
	if (!Number.isFinite(requested)) return DEFAULT_CONFIRMATION_TIMEOUT_SECONDS * 1_000;
	const bounded = Math.min(
		MAX_CONFIRMATION_TIMEOUT_SECONDS,
		Math.max(MIN_CONFIRMATION_TIMEOUT_SECONDS, Math.trunc(requested)),
	);
	return bounded * 1_000;
}

/**
 * The API's own identity, derived host-side from the operating-system account
 * that started the server. It is never read from a request body, a header, or
 * a model-authored field.
 */
export function serveWorkbenchActorId(): string {
	let name = "";
	try {
		name = userInfo().username;
	} catch {
		name = "";
	}
	const fallback = basename(resolve(process.cwd()));
	const raw = (name || fallback || "operator").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
	return `api:${raw || "operator"}`;
}

export function createServeConfirmationRegistry(
	options: ServeConfirmationRegistryOptions,
): ServeConfirmationRegistry {
	const actorId = options.actorId;
	const now = options.now ?? (() => new Date().toISOString());
	const timeoutMs = confirmationTimeoutMs(options.timeoutSeconds);
	const pendingById = new Map<string, PendingRecord>();
	const settledById = new Map<string, ServeConfirmationSettlement>();
	let closed = false;

	const remember = (confirmationId: string, settlement: ServeConfirmationSettlement): void => {
		settledById.set(confirmationId, settlement);
		while (settledById.size > MAX_REMEMBERED_SETTLEMENTS) {
			const oldest = settledById.keys().next();
			if (oldest.done) break;
			settledById.delete(oldest.value);
		}
	};

	const notifyOpened = (confirmation: ServeConfirmationProjection): void => {
		try {
			options.onOpened?.(confirmation);
		} catch {
			// The event stream can never change a gate decision.
		}
	};

	const notifyClosed = (
		confirmation: ServeConfirmationProjection,
		settlement: ServeConfirmationSettlement,
	): void => {
		try {
			options.onClosed?.(confirmation, settlement);
		} catch {
			// The event stream can never change a gate decision.
		}
	};

	const newConfirmationId = (): string => {
		for (;;) {
			const id = randomBytes(24).toString("base64url");
			if (!pendingById.has(id) && !settledById.has(id)) return id;
		}
	};

	interface OpenInput {
		operation: OperationState;
		kind: ServeConfirmationKind;
		title: string;
		reason: string;
		question: string;
		subject: unknown;
		subjectHash: string;
		policy: WorkbenchGateClass;
		estimate?: WorkbenchRunEstimate;
		options?: readonly { label: string; taskCount: number }[];
		signal?: AbortSignal;
	}

	/** Open one pending confirmation and block until it is settled, however. */
	const open = (input: OpenInput): Promise<GateAnswer> => {
		if (closed) return Promise.resolve({ approved: false });
		if (pendingById.size >= MAX_OPEN_CONFIRMATIONS) return Promise.resolve({ approved: false });
		const openedAt = now();
		const confirmationId = newConfirmationId();
		const projection: ServeConfirmationProjection = {
			confirmationId,
			operationId: input.operation.operationId,
			kind: input.kind,
			title: input.title,
			reason: input.reason,
			question: input.question,
			subject: input.subject,
			subjectHash: input.subjectHash,
			policy: input.policy,
			...(input.estimate ? { estimate: input.estimate } : {}),
			...(input.options ? { options: input.options } : {}),
			openedAt,
			expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
		};
		return new Promise<GateAnswer>((resolveAnswer) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const record: PendingRecord = {
				projection,
				operation: input.operation,
				settled: false,
				settle(settlement, answer) {
					if (record.settled) return;
					record.settled = true;
					if (timer) clearTimeout(timer);
					input.signal?.removeEventListener("abort", onAbort);
					pendingById.delete(confirmationId);
					remember(confirmationId, settlement);
					notifyClosed(projection, settlement);
					resolveAnswer(answer);
				},
			};
			function onAbort(): void {
				record.settle("aborted", { approved: false });
			}
			timer = setTimeout(() => record.settle("expired", { approved: false }), timeoutMs);
			timer.unref?.();
			pendingById.set(confirmationId, record);
			input.operation.opened.push(record);
			for (const waiter of [...input.operation.waiters]) {
				input.operation.waiters.delete(waiter);
				waiter(record);
			}
			if (input.signal?.aborted) {
				record.settle("aborted", { approved: false });
				return;
			}
			input.signal?.addEventListener("abort", onAbort, { once: true });
			notifyOpened(projection);
		});
	};

	const gateFor = (operation: OperationState): WorkbenchHumanGate => ({
		async confirm(confirmation: WorkbenchConfirmation, signal?: AbortSignal) {
			// `routine` is the one class the Workbench itself declares needs no
			// dialog, and the cost guard has already turned an expensive routine
			// run into `one-question` before this gate ever sees it.
			if (confirmation.policy === "routine") return { approved: true, actorId };
			const answer = await open({
				operation,
				kind: confirmation.kind,
				title: confirmation.title,
				reason: confirmation.reason,
				question: confirmation.question,
				subject: confirmation.subject,
				subjectHash: confirmation.subjectHash,
				policy: confirmation.policy,
				...(confirmation.estimate ? { estimate: confirmation.estimate } : {}),
				...(signal ? { signal } : {}),
			});
			return answer.approved ? { approved: true, actorId } : { approved: false };
		},
		async selectSealed(request, signal?: AbortSignal) {
			// One evaluator-owned holdout needs no picker, exactly as in the TUI;
			// the confirmation that follows still shows its size before anything runs.
			if (request.options.length === 1) return { approved: true, actorId, selectedIndex: 0 };
			const options = request.options.map((option) => ({
				label: option.label,
				taskCount: option.taskCount,
			}));
			const subject = { title: request.title, options };
			const answer = await open({
				operation,
				kind: "select-sealed",
				title: request.title,
				reason: "Choose the exact sealed holdout this verification measures.",
				question: `${request.title}?`,
				subject,
				subjectHash: hashValue(subject),
				policy: "consequential",
				options,
				...(signal ? { signal } : {}),
			});
			if (!answer.approved || answer.selectedIndex === undefined) return { approved: false };
			return { approved: true, actorId, selectedIndex: answer.selectedIndex };
		},
	});

	return {
		beginOperation(): ServeOperation {
			const state: OperationState = {
				operationId: randomBytes(12).toString("base64url"),
				opened: [],
				waiters: new Set(),
			};
			return {
				operationId: state.operationId,
				gate: gateFor(state),
				openedCount: () => state.opened.length,
				nextConfirmation(seen, finished) {
					const already = state.opened[seen];
					if (already) return Promise.resolve(already.projection);
					return new Promise<ServeConfirmationProjection | null>((resolveNext) => {
						const waiter = (record: PendingRecord): void => resolveNext(record.projection);
						state.waiters.add(waiter);
						void finished.then(
							() => {
								if (state.waiters.delete(waiter)) resolveNext(null);
							},
							() => {
								if (state.waiters.delete(waiter)) resolveNext(null);
							},
						);
					});
				},
				dispose() {
					state.waiters.clear();
					for (const record of state.opened) record.settle("server-closed", { approved: false });
				},
			};
		},
		pending(): ServeConfirmationProjection[] {
			return [...pendingById.values()].map((record) => record.projection);
		},
		find(confirmationId): ServeConfirmationProjection | null {
			return pendingById.get(confirmationId)?.projection ?? null;
		},
		answer(confirmationId, answer): ServeConfirmationAnswerResult {
			const record = pendingById.get(confirmationId);
			if (!record) {
				const settlement = settledById.get(confirmationId);
				// A replay is refused as settled; an id nobody minted is unknown.
				return settlement ? { outcome: "already-settled", settlement } : { outcome: "unknown" };
			}
			if (answer.subjectHash !== record.projection.subjectHash) {
				// The platform answered about a different subject. Fail closed: the
				// blocked operation refuses, and no second attempt can slip past.
				record.settle("subject-changed", { approved: false });
				return { outcome: "subject-changed", expected: record.projection.subjectHash };
			}
			if (!answer.approved) {
				record.settle("declined", { approved: false });
				return { outcome: "recorded", confirmation: record.projection, approved: false };
			}
			if (record.projection.kind === "select-sealed") {
				const count = record.projection.options?.length ?? 0;
				const index = answer.selectedIndex;
				if (
					index === undefined || !Number.isSafeInteger(index) ||
					index < 0 || index >= count
				) {
					return {
						outcome: "invalid",
						message: `approving a sealed-holdout selection needs selectedIndex between 0 and ${count - 1}`,
					};
				}
				record.settle("approved", { approved: true, selectedIndex: index });
				return { outcome: "recorded", confirmation: record.projection, approved: true };
			}
			if (answer.selectedIndex !== undefined) {
				return { outcome: "invalid", message: "selectedIndex applies only to a sealed-holdout selection" };
			}
			record.settle("approved", { approved: true });
			return { outcome: "recorded", confirmation: record.projection, approved: true };
		},
		close() {
			closed = true;
			for (const record of [...pendingById.values()]) {
				record.settle("server-closed", { approved: false });
			}
		},
	};
}
