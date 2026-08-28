import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { emitRunEvent, type RunEventListener } from "../run-events.js";
import { createRunProgressPresenter } from "./run-progress.js";

export type BuilderLiveTraceOutcome = "completed" | "error" | "aborted";

export interface BuilderLiveTrace {
	url: string;
	onRunEvent: RunEventListener;
	finish(outcome: BuilderLiveTraceOutcome): void;
}

export type BeginBuilderLiveTrace = () => BuilderLiveTrace | null | Promise<BuilderLiveTrace | null>;

export interface BuilderRunObservation {
	liveTraceUrl: string | null;
	onRunEvent: RunEventListener;
	finish(outcome: BuilderLiveTraceOutcome): void;
}

function boundedLoopbackLiveUrl(value: string): string | null {
	if (Buffer.byteLength(value, "utf8") > 2_048) return null;
	try {
		const parsed = new URL(value);
		if (
			parsed.protocol !== "http:" ||
			!new Set(["127.0.0.1", "localhost", "[::1]"]).has(parsed.hostname) ||
			!parsed.port ||
			parsed.username ||
			parsed.password ||
			parsed.search ||
			parsed.hash ||
			!parsed.pathname.startsWith("/live/")
		) return null;
		return parsed.toString();
	} catch {
		return null;
	}
}

function safelyFinish(liveTrace: BuilderLiveTrace, outcome: BuilderLiveTraceOutcome): void {
	try {
		const returned = liveTrace.finish(outcome) as unknown;
		if (
			typeof returned === "object" && returned !== null &&
			"then" in returned && typeof (returned as { then?: unknown }).then === "function"
		) {
			void Promise.resolve(returned).catch(() => undefined);
		}
	} catch {
		// Web observation is best-effort and cannot affect the run.
	}
}

/** Compose TUI and web observation behind one fail-open host-only lifecycle. */
export async function beginBuilderRunObservation(
	ui: Pick<ExtensionUIContext, "setStatus" | "setWidget">,
	beginLiveTrace?: BeginBuilderLiveTrace,
): Promise<BuilderRunObservation> {
	let liveTrace: BuilderLiveTrace | null = null;
	if (beginLiveTrace) {
		try {
			const candidate = await beginLiveTrace();
			if (candidate) {
				const url = boundedLoopbackLiveUrl(candidate.url);
				if (url) liveTrace = { ...candidate, url };
				else safelyFinish(candidate, "aborted");
			}
		} catch {
			// A bind/capacity failure leaves the evaluation fully operational.
		}
	}
	const presenter = createRunProgressPresenter(ui, {
		...(liveTrace ? { liveTraceUrl: liveTrace.url } : {}),
	});
	let finished = false;
	return {
		liveTraceUrl: liveTrace?.url ?? null,
		onRunEvent(event) {
			emitRunEvent(presenter.onRunEvent, event);
			emitRunEvent(liveTrace?.onRunEvent, event);
		},
		finish(outcome) {
			if (finished) return;
			finished = true;
			if (liveTrace) safelyFinish(liveTrace, outcome);
			presenter.dispose();
		},
	};
}
