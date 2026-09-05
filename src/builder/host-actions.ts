import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { relative, sep } from "node:path";
import { Type } from "typebox";
import { corpusTaskLookup, datasetExportDoneLine, DatasetExportError, exportDataset, sealedDatasetHashesFor } from "../application/export-dataset.js";
import { SEALED_GATE_POLICY } from "../domain/comparison-gate.js";
import { t } from "../i18n.js";
import { percent } from "../measurement.js";
import type { AhdeWorkbench } from "../workbench/workbench.js";
import type { BuilderJobs } from "./jobs.js";
import { MAX_LABEL_SAMPLE, NoJudgedEvidence, runBuilderLabelSession, type LabelScreen } from "./label-session.js";
import { compileBuilderPassport } from "./passport-presentation.js";
import { oneLine } from "./render/format.js";
import { renderVersionPassport } from "./render/passport.js";
import { renderExecutiveVersionCard } from "./render/version-card.js";
import { markerPaint, stripMarkers, type TranscriptPresenter } from "./transcript.js";

export type BuilderHostAction =
	| { kind: "jobs" | "stop" | "import-exam" }
	| { kind: "passport"; version?: string }
	| { kind: "dataset"; all?: boolean }
	| { kind: "label-judge"; sample?: number };
export interface BuilderHostActions {
	execute(action: BuilderHostAction, ctx: ExtensionContext, signal?: AbortSignal): Promise<{ kind: BuilderHostAction["kind"]; message: string }>;
	/** Shortcut-only input. It never becomes a model tool parameter or result. */
	importExam(ctx: ExtensionContext, signal?: AbortSignal, givenPath?: string): Promise<void>;
}
export interface BuilderHostActionOptions {
	workbench: Pick<AhdeWorkbench, "runsRoot" | "stateRoot" | "projectId" | "projectDir" | "view">;
	jobs: BuilderJobs;
	presenter: TranscriptPresenter;
	onWorkbenchChanged?: () => void | Promise<void>;
	importSealedHoldout?: (input: { sourcePath: string; name: string }) => { taskCount: number };
}
function besideTarget(projectDir: string, path: string): string {
	const rel = relative(projectDir, path);
	return rel && !rel.startsWith("..") && !rel.startsWith(sep) ? rel : path;
}
export function createBuilderHostActions(options: BuilderHostActionOptions): BuilderHostActions {
	const { workbench, presenter, jobs } = options;
	const changed = async () => { try { await options.onWorkbenchChanged?.(); } catch { /* Presentation cannot undo a saved result. */ } };
	const requireHost = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("This action requires the local terminal host");
	};
	const assertAvailable = (): void => { const busy = jobs.busy(); if (busy) throw new Error(busy); };
	const passport = async (ctx: ExtensionContext, version = "") => {
		// The passport compiler serves the CLI too, so its refusals are English
		// sentences. The two an operator actually walks into are worded here.
		let compiled: Awaited<ReturnType<typeof compileBuilderPassport>>;
		try {
			compiled = await compileBuilderPassport(workbench, { ...(version ? { version } : {}), save: true });
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (/^nothing has been promoted yet/.test(reason)) throw new Error(t("passport.none-yet"), { cause: error });
			if (/^no promoted version /.test(reason)) throw new Error(t("passport.no-version", { version }), { cause: error });
			throw error;
		}
		const { passport, card, written, reportWritten } = compiled;
		presenter.show(ctx, {
			title: t("panel.title", { detail: t("panel.passport") }),
			tone: "info",
			lines: [
				...renderExecutiveVersionCard(card, markerPaint),
				reportWritten ? t("release.html.saved", { path: reportWritten }) : markerPaint.warning(t("release.html.not-saved")),
				"",
				...renderVersionPassport(passport, markerPaint),
				"",
				written
					? `${markerPaint.dim(t("passport.written-to"))} ${oneLine(written, 100)}`
					: markerPaint.warning(t("cmd.passport-not-writable")),
			],
		});
		return renderExecutiveVersionCard(card, markerPaint).map(stripMarkers).join("\n");
	};
	const dataset = async (ctx: ExtensionContext, all = false) => {
		const scope = { stateRoot: workbench.stateRoot, projectId: workbench.projectId };
		let result;
		try {
			result = exportDataset({
				runsRoot: workbench.runsRoot,
				outRoot: workbench.projectDir,
				...(all ? { all: true } : { latest: true }),
				sealedDatasetHashes: sealedDatasetHashesFor(scope),
				tasks: corpusTaskLookup(scope),
			});
		} catch (error) {
			// The only refusal this command can walk into: nothing exportable
			// has been recorded yet. Everything else is a real fault.
			if (!(error instanceof DatasetExportError)) throw error;
			throw new Error(t("export.none"), { cause: error });
		}
		if (result.counts.exported === 0) {
			presenter.show(ctx, {
				title: t("panel.title", { detail: t("panel.export") }),
				tone: "warning",
				lines: [t("export.none")],
			});
			return;
		}
		presenter.show(ctx, {
			title: t("panel.title", { detail: t("panel.export") }),
			tone: "info",
			lines: [datasetExportDoneLine(result, oneLine(besideTarget(workbench.projectDir, result.path), 100))],
		});
		return datasetExportDoneLine(result, oneLine(besideTarget(workbench.projectDir, result.path), 100));
	};
	const labelJudge = async (ctx: ExtensionContext, signal?: AbortSignal, sample?: number) => {
		if (typeof ctx.ui.select !== "function") {
			throw new Error(t("cmd.err.label-host"));
		}
		const select = ctx.ui.select.bind(ctx.ui);
		const view = await workbench.view();
		const screen: LabelScreen = {
			show: (block) => presenter.show(ctx, block),
			select: (title, choices) => select(title, choices, { signal }),
			input: (title, placeholder) => ctx.ui.input(title, placeholder, { signal }),
			notify: (message, tone) => ctx.ui.notify(message, tone),
		};
		let result;
		try {
			result = await runBuilderLabelSession({
				runsRoot: workbench.runsRoot,
				stateRoot: workbench.stateRoot,
				projectId: workbench.projectId,
				targetDir: workbench.projectDir,
				targetId: view.target.id,
				...(sample !== undefined ? { sample } : {}),
				screen,
				paint: markerPaint,
			});
		} catch (error) {
			// The one refusal that is not a fault: there is no judge to check.
			if (error instanceof NoJudgedEvidence) {
				ctx.ui.notify(error.message, "info");
				return;
			}
			throw error;
		}
		if (result.labelled === 0) return;
		// The Builder is told the number, not the answers: what it may say next
		// is how far the judge can be trusted, never which case the operator
		// disliked. The visible half of the injection says exactly that.
		const stats = result.stats;
		presenter.note(
			`Operator ran /label on eval run ${result.evalRunId}: ${result.labelled} answer(s) graded blind` +
			(stats
				? `, judge agreement now ${percent(stats.agreement)} over ${stats.n} independent subject(s)` +
				` (false-pass ${stats.falsePass}, false-fail ${stats.falseFail}).`
				: ".") +
			" Do not offer the judge check again for this revision. Never quote an individual label back to them.",
			{ label: t("label.done") },
		);
		await changed();
		return t("host.labelled", { count: result.labelled });
	};
	const importExam = async (ctx: ExtensionContext, signal?: AbortSignal, givenPath = ""): Promise<void> => {
		requireHost(ctx); assertAvailable();
		const minimum = SEALED_GATE_POLICY.minTasks;
		if (!options.importSealedHoldout) throw new Error(t("cmd.err.holdout-unavailable"));
		const sourcePath = givenPath || await ctx.ui.input(t("holdout.path-prompt"), "./private-holdout.jsonl", { signal });
		if (signal?.aborted) throw signal.reason ?? new Error("operation cancelled");
		if (sourcePath === undefined || !sourcePath.trim()) {
			ctx.ui.notify(t("error.cancelled"), "info");
			return;
		}
		const name = await ctx.ui.input(t("holdout.name-prompt"), t("holdout.name-default"), { signal });
		if (signal?.aborted) throw signal.reason ?? new Error("operation cancelled");
		if (name === undefined || !name.trim()) {
			ctx.ui.notify(t("error.cancelled"), "info");
			return;
		}
		const approved = await ctx.ui.confirm(
			t("holdout.import-title"),
			t("holdout.import-question", { path: sourcePath.trim() }),
			{ signal },
		);
		if (!approved) {
			ctx.ui.notify(t("error.cancelled"), "info");
			return;
		}
		if (signal?.aborted) throw signal.reason ?? new Error("operation cancelled");
		assertAvailable();
		const result = options.importSealedHoldout({ sourcePath: sourcePath.trim(), name: name.trim() });
		await changed();
		try {
			presenter.show(ctx, {
				title: t("panel.holdout-imported"),
				tone: result.taskCount >= minimum ? "success" : "warning",
				lines: result.taskCount >= minimum
					? [t("holdout.imported", { count: result.taskCount }), t("holdout.hidden")]
					: [
						t("holdout.imported-short", {
							count: result.taskCount,
							minimum,
							missing: minimum - result.taskCount,
						}),
						t("holdout.import-more"),
					],
			});
		} catch { /* Import is already durable; a missing panel cannot undo it. */ }
	};
	return {
		importExam,
		async execute(action, ctx, signal) {
			requireHost(ctx);
			if (signal?.aborted) throw signal.reason ?? new Error("operation cancelled");
			if (action.kind === "label-judge" || action.kind === "import-exam") assertAvailable();
			let message: string;
			switch (action.kind) {
				case "jobs": message = jobs.lines().join("\n"); break;
				case "stop": message = jobs.stop() ? t("host.stopping") : t("job.nothing-to-stop"); break;
				case "passport": message = await passport(ctx, action.version); break;
				case "dataset": message = await dataset(ctx, action.all) ?? t("export.none"); break;
				case "label-judge": message = await labelJudge(ctx, signal, action.sample) ?? t("host.label-not-saved"); break;
				case "import-exam":
					try { await importExam(ctx, signal); message = t("host.exam-finished"); }
					catch (error) {
						// A private import can fail with a path in its error. Show it only in
						// the host dialog surface; never copy it into a model tool exception.
						try { ctx.ui.notify(oneLine(error instanceof Error ? error.message : String(error), 500), "error"); }
						catch { /* The private error must never escape through a failed UI surface. */ }
						throw new Error(t("host.exam-import-failed"));
					}
					break;
			}
			return { kind: action.kind, message };
		},
	};
}

/** A closed vocabulary of missing host capabilities, never a command dispatcher. */
export function builderHostActionTool(actions: BuilderHostActions) {
	return defineTool({
		name: "ahde_host_action", label: "Terminal action", executionMode: "sequential",
		description: "Host-owned actions requested in ordinary language. jobs reads the active operation; stop requests cancellation and preserves completed artifacts. passport shows/saves a version report; dataset exports recorded DEVELOPMENT conversations only. label-judge opens a private blind human grading dialog; only aggregates return. import-exam privately asks the operator for a file and imports a sealed exam; NEVER ask for its path or content in conversation. No slash command, shell, path or approval parameter is accepted. Read Workbench again after a stopped operation or a private exam dialog.",
		parameters: Type.Union([
			Type.Object({ kind: Type.Literal("jobs") }, { additionalProperties: false }),
			Type.Object({ kind: Type.Literal("stop") }, { additionalProperties: false }),
			Type.Object({ kind: Type.Literal("passport"), version: Type.Optional(Type.String({ minLength: 1, maxLength: 80, pattern: "^\\S+$" })) }, { additionalProperties: false }),
			Type.Object({ kind: Type.Literal("dataset"), all: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
			Type.Object({ kind: Type.Literal("label-judge"), sample: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LABEL_SAMPLE })) }, { additionalProperties: false }),
			Type.Object({ kind: Type.Literal("import-exam") }, { additionalProperties: false }),
		]),
		async execute(_id, input, signal, _update, ctx) {
			const result = await actions.execute(input, ctx, signal);
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
		},
	});
}
