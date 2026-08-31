import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	approveBuilderSpecDraft,
	describeSpecDraftApproval,
	loadSpecApprovalReceipt,
	saveBuilderSpecDraft,
	type SpecApprovalReceipt,
} from "./builder-authoring.js";
import { AgentSpecSchema, loadSpecSnapshot, type AgentSpec, type SpecSnapshot } from "../spec.js";

/**
 * The operator's `spec.md` becomes the typed immutable Spec the ship gate
 * needs.
 *
 * `spec.md` is prose: the contract a human wrote for a client. The engine gates
 * on `SpecSnapshot`, a typed object nothing outside Builder Pi could create.
 * This module is the one translation between them — a heading/bullet reader,
 * not a parser with opinions — plus the draft→approval pair the receipt chain
 * already implements. Approving is idempotent by construction: the draft id is
 * content-addressed, so the same document finds the same receipt and returns
 * the specification it already approved.
 */

/** A document larger than this is not a specification; it is a corpus. */
const MAX_SPEC_DOCUMENT_BYTES = 64 * 1024;

/** The actor id every local operator-run command already records. */
export const LOCAL_OPERATOR_ACTOR_ID = "local-user";

const APPROVAL_REASON =
	"Approved at the terminal by the operator running `ahde spec approve`.";

type SpecListField =
	| "users"
	| "jobs"
	| "inputs"
	| "allowedActions"
	| "successCriteria"
	| "constraints"
	| "openQuestions";

/**
 * Heading names this reader recognizes. Everything else in the document is
 * context for the human and is deliberately ignored rather than guessed at.
 */
const SECTION_ALIASES: Readonly<Record<string, SpecListField | "purpose">> = {
	"purpose": "purpose",
	"what it does": "purpose",
	"summary": "purpose",
	"overview": "purpose",
	"цель": "purpose",
	"назначение": "purpose",
	"users": "users",
	"user": "users",
	"audience": "users",
	"пользователи": "users",
	"jobs": "jobs",
	"jobs to be done": "jobs",
	"tasks": "jobs",
	"задачи": "jobs",
	"inputs": "inputs",
	"input": "inputs",
	"входы": "inputs",
	"вход": "inputs",
	"allowed actions": "allowedActions",
	"actions": "allowedActions",
	"разрешённые действия": "allowedActions",
	"разрешенные действия": "allowedActions",
	"действия": "allowedActions",
	"success criteria": "successCriteria",
	"criteria": "successCriteria",
	"acceptance criteria": "successCriteria",
	"критерии успеха": "successCriteria",
	"критерии": "successCriteria",
	"constraints": "constraints",
	"limits": "constraints",
	"ограничения": "constraints",
	"open questions": "openQuestions",
	"questions": "openQuestions",
	"открытые вопросы": "openQuestions",
	"вопросы": "openQuestions",
};

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const BULLET = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(.*)$/;

function normalizeHeading(text: string): string {
	return text
		.replace(/[*_`]/gu, "")
		.replace(/[:：]\s*$/u, "")
		.replace(/\s+/gu, " ")
		.trim()
		.toLowerCase();
}

interface Section {
	field: SpecListField | "purpose" | null;
	heading: string;
	level: number;
	bullets: string[];
	paragraph: string[];
}

function newSection(field: Section["field"], heading: string, level: number): Section {
	return { field, heading, level, bullets: [], paragraph: [] };
}

export interface ParsedSpecDocument {
	spec: AgentSpec;
	/** Headings the reader did not recognize, so a caller can say so. */
	ignoredHeadings: string[];
}

export interface ParseSpecDocumentOptions {
	/** Wins over the document's own first level-1 heading. */
	title?: string;
	/** Only used in error text, so the operator knows which file is wrong. */
	label?: string;
}

/**
 * Read one markdown/plain document into the typed Spec. Headings name the
 * fields; bullets under a heading are its items; loose text under `purpose`
 * (or before the first section) is the purpose.
 */
export function parseSpecDocument(text: string, options: ParseSpecDocumentOptions = {}): ParsedSpecDocument {
	const label = options.label ?? "spec document";
	const lines = text.replace(/\r\n?/gu, "\n").split("\n");
	const sections: Section[] = [];
	const lead = newSection(null, "", 0);
	let current = lead;
	let documentTitle: string | null = null;

	for (const line of lines) {
		const heading = HEADING.exec(line);
		if (heading) {
			const level = heading[1]!.length;
			const raw = heading[2]!.trim();
			const field = SECTION_ALIASES[normalizeHeading(raw)] ?? null;
			// A level-1 heading that names no field is the document's title.
			if (field === null && level === 1 && documentTitle === null) {
				documentTitle = raw.replace(/[*_`]/gu, "").trim();
				continue;
			}
			current = newSection(field, raw, level);
			sections.push(current);
			continue;
		}
		const bullet = BULLET.exec(line);
		if (bullet) {
			const item = bullet[1]!.trim();
			if (item.length > 0) current.bullets.push(item);
			continue;
		}
		if (line.trim().length > 0) current.paragraph.push(line.trim());
	}
	if (lead.bullets.length > 0 || lead.paragraph.length > 0) sections.unshift(lead);

	const listOf = (field: SpecListField): string[] => {
		const items: string[] = [];
		for (const section of sections) {
			if (section.field !== field) continue;
			// A section written as prose still contributes: one line, one item.
			items.push(...(section.bullets.length > 0 ? section.bullets : section.paragraph));
		}
		return items;
	};

	const purposeSections = sections.filter((section) => section.field === "purpose");
	const purposeText = (purposeSections.length > 0 ? purposeSections : [lead])
		.flatMap((section) => [...section.paragraph, ...section.bullets])
		.join(" ")
		.trim();

	const title = (options.title ?? documentTitle ?? "").trim();
	if (title.length === 0) {
		throw new Error(`${label} has no title: add a \`# <title>\` heading or pass --title`);
	}
	if (purposeText.length === 0) {
		throw new Error(`${label} has no purpose: add a \`## Purpose\` section or an opening paragraph`);
	}

	const candidate = {
		schemaVersion: 1,
		title,
		purpose: purposeText,
		users: listOf("users"),
		jobs: listOf("jobs"),
		inputs: listOf("inputs"),
		allowedActions: listOf("allowedActions"),
		successCriteria: listOf("successCriteria"),
		constraints: listOf("constraints"),
		openQuestions: listOf("openQuestions"),
	};
	const parsed = AgentSpecSchema.safeParse(candidate);
	if (!parsed.success) {
		const detail = parsed.error.issues
			.map((issue) => `${issue.path.join(".") || "spec"}: ${issue.message}`)
			.join("; ");
		throw new Error(`${label} is not a valid Spec — ${detail}`);
	}
	const ignoredHeadings = sections
		.filter((section) => section.field === null && section.heading.length > 0)
		.map((section) => section.heading);
	return { spec: parsed.data, ignoredHeadings: [...new Set(ignoredHeadings)] };
}

export function readSpecDocument(path: string): { text: string; path: string } {
	const resolved = resolve(path);
	const entry = lstatSync(resolved);
	if (entry.isSymbolicLink() || !entry.isFile()) {
		throw new Error(`spec document must be a regular non-symlink file: ${resolved}`);
	}
	if (entry.size > MAX_SPEC_DOCUMENT_BYTES) {
		throw new Error(`spec document exceeds ${MAX_SPEC_DOCUMENT_BYTES} bytes: ${resolved}`);
	}
	return { text: readFileSync(resolved, "utf8"), path: resolved };
}

export interface ApproveSpecDocumentOptions {
	stateRoot: string;
	projectId: string;
	/** The markdown/plain document. Read, hashed, and kept as the Spec's source. */
	documentPath: string;
	title?: string;
	actorId?: string;
	now?: () => string;
}

export interface ApproveSpecDocumentResult {
	/** The approved immutable snapshot's id — what `--spec` takes. */
	specId: string;
	draftSpecId: string;
	/** `approved` on the call that recorded the receipt, `already-approved` after. */
	disposition: "approved" | "already-approved";
	receipt: SpecApprovalReceipt;
	snapshot: SpecSnapshot;
	ignoredHeadings: string[];
}

/**
 * Approve exactly the Spec this document describes. The operator running the
 * command is the human gate, so the actor is the same local id promotion uses
 * and the receipt is written on the spot. Running it twice on unchanged text
 * finds the existing receipt and changes nothing.
 */
export function approveSpecDocument(options: ApproveSpecDocumentOptions): ApproveSpecDocumentResult {
	const document = readSpecDocument(options.documentPath);
	const parsed = parseSpecDocument(document.text, {
		...(options.title === undefined ? {} : { title: options.title }),
		label: document.path,
	});
	const draft = saveBuilderSpecDraft({
		stateRoot: options.stateRoot,
		projectId: options.projectId,
		spec: parsed.spec,
		sourceText: document.text,
		...(options.now ? { now: options.now } : {}),
	});
	const existing = existingApproval(options.stateRoot, options.projectId, draft.id);
	if (existing) {
		return {
			specId: existing.approvedSpec.specId,
			draftSpecId: draft.id,
			disposition: "already-approved",
			receipt: existing,
			snapshot: loadSpecSnapshot(options.stateRoot, options.projectId, existing.approvedSpec.specId),
			ignoredHeadings: parsed.ignoredHeadings,
		};
	}
	const subject = describeSpecDraftApproval(options.stateRoot, options.projectId, draft.id);
	const approval = approveBuilderSpecDraft({
		stateRoot: options.stateRoot,
		projectId: options.projectId,
		draftSpecId: draft.id,
		expectedDraftSnapshotHash: subject.draftSnapshotHash,
		actor: { kind: "human", id: options.actorId ?? LOCAL_OPERATOR_ACTOR_ID },
		reason: APPROVAL_REASON,
	}, options.now ? { now: options.now } : {});
	return {
		specId: approval.approved.id,
		draftSpecId: draft.id,
		disposition: "approved",
		receipt: approval.receipt,
		snapshot: approval.approved,
		ignoredHeadings: parsed.ignoredHeadings,
	};
}

/**
 * A receipt this exact draft already has. Any other failure to read one is a
 * missing receipt, not a broken one — `loadSpecApprovalReceipt` re-verifies
 * both snapshots and would rather refuse than hand back a stale approval.
 */
function existingApproval(
	stateRoot: string,
	projectId: string,
	draftSpecId: string,
): SpecApprovalReceipt | null {
	try {
		return loadSpecApprovalReceipt(stateRoot, projectId, draftSpecId);
	} catch {
		return null;
	}
}
