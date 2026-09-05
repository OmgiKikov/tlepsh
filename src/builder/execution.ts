import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { t } from "../i18n.js";
import type { WorkbenchDecisionInput, WorkbenchDecisionResult, WorkbenchHumanGate } from "../workbench/types.js";
import { type BuilderJobResult, type BuilderJobs, type JobRunOptions } from "./jobs.js";
import { beginBuilderRunObservation, type BeginBuilderLiveTrace, type BuilderLiveTraceOutcome } from "./run-observation.js";

/** One classification for both conversation tools and shortcuts. Authority remains in the gate. */
function measures(input: WorkbenchDecisionInput): boolean {
	return ["run-current", "start-testing", "run-eval", "verify-candidate", "calibrate", "regrade", "improve", "ship"].includes(input.kind)
		|| (input.kind === "apply-proposal" && input.verify !== undefined);
}

/**
 * The Builder's single execution seam: same job, signal, gate reporting and
 * live trace regardless of whether a model tool or a shortcut requested it.
 * Selection and credentials are still resolved by their trusted host adapter.
 */
export async function executeBuilderDecision(options: {
	jobs: BuilderJobs;
	ctx: ExtensionContext;
	input: WorkbenchDecisionInput;
	source: string;
	signal?: AbortSignal;
	gate: WorkbenchHumanGate;
	beginLiveTrace?: BeginBuilderLiveTrace;
	/** Headless tools stay foreground so their caller receives the durable result. */
	background?: boolean;
	hasResultPanel?: boolean;
	run(gate: WorkbenchHumanGate, execution: Pick<JobRunOptions, "signal" | "onRunEvent">): Promise<WorkbenchDecisionResult | null>;
	present(result: WorkbenchDecisionResult, background: boolean, liveTraceUrl: string | null): Promise<string>;
}): Promise<BuilderJobResult> {
	let liveTraceUrl: string | null = null;
	return options.jobs.start({
		command: options.source,
		signal: options.signal,
		background: measures(options.input) && options.background !== false,
		label: (kind) => !measures(options.input) ? t("job.label.operation") : kind === "verify-candidate" ? t("job.label.verify")
			: kind === "calibrate" ? t("job.label.calibrate")
				: kind === "regrade" ? t("job.label.regrade") : t("job.label.run"),
		async run({ signal, onRunEvent, authorized }) {
			const observation = measures(options.input)
				? await beginBuilderRunObservation(options.ctx.ui, options.beginLiveTrace) : null;
			liveTraceUrl = observation?.liveTraceUrl ?? null;
			let outcome: BuilderLiveTraceOutcome = "error";
			const gate: WorkbenchHumanGate = {
				async confirm(confirmation, confirmSignal) {
					const approval = await options.gate.confirm(confirmation, confirmSignal);
					if (approval.approved && !signal.aborted) {
						observation?.plan(confirmation.estimate?.executions ?? null);
						authorized({ kind: confirmation.kind, estimate: confirmation.estimate ?? null });
					}
					return approval;
				},
				selectSealed: (request, confirmSignal) => options.gate.selectSealed(request, confirmSignal),
			};
			try {
				const result = await options.run(gate, {
					signal, onRunEvent: (event) => {
						if (!options.jobs.closed()) observation?.onRunEvent(event);
						onRunEvent(event);
					}
				});
				outcome = result ? "completed" : "aborted";
				return result;
			} catch (error) {
				if (signal.aborted) outcome = "aborted";
				throw error;
			} finally {
				observation?.finish(outcome);
				if (liveTraceUrl && !options.jobs.closed() && (outcome !== "completed" || !options.hasResultPanel)) {
					try { options.ctx.ui.notify(t("card.live-trace-retained", { url: liveTraceUrl }), "info"); }
					catch { /* Evidence remains available when the presentation host closes. */ }
				}
			}
		},
		present: (result, background) => options.present(result, background, liveTraceUrl),
	});
}
