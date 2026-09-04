import type { WorkbenchRunEstimate } from "../../workbench/transition-policy.js";
import type {
	WorkbenchCandidateSummary,
	WorkbenchConfirmation,
	WorkbenchDatasetCase,
	WorkbenchProposalReview,
} from "../../workbench/types.js";
import { plural, t } from "../../i18n.js";
import { sealedOutcomeLabel } from "../../domain/comparison-gate.js";
import { diffStats, renderUnifiedDiff } from "./diff.js";
import { bullets, clean, numbered, oneLine, shortHash, shortSha, wrap } from "./format.js";
import type { Paint } from "./paint.js";
import { renderToolPermissions, toolPermissionsFromDiff } from "./tool-permissions.js";
import {
	predictionAbsentLine,
	predictionNoteLine,
	predictionPromiseLine,
} from "./prediction.js";
import { ProposalPredictionSchema, type ProposalPrediction } from "../../builders/adapters.js";
import { renderCandidate, renderDatasetCases } from "./view.js";

type Bag = Record<string, unknown>;

/**
 * A confirmation subject is a bounded projection, so the prediction arrives
 * here as plain data. It is re-parsed rather than trusted: a dialog never
 * renders a promise it cannot validate.
 */
function predictionOf(value: unknown): ProposalPrediction | null {
	if (value === null || value === undefined) return null;
	const parsed = ProposalPredictionSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

/** ` · improved`, from the outcome token the ship subject carries. */
function sealedOutcomeSuffix(value: unknown): string {
	if (value === "improved") return ` · ${sealedOutcomeLabel("improved")}`;
	if (value === "no-regression") return ` · ${sealedOutcomeLabel("no-regression")}`;
	return "";
}

function bag(value: unknown): Bag {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Bag) : {};
}

function text(value: unknown, max = 160): string {
	if (typeof value === "string") return oneLine(value, max);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null || value === undefined) return "—";
	return oneLine(JSON.stringify(value), max);
}

/**
 * `model.timeoutMs` in seconds, because it is read next to a run that lasts
 * minutes. It bounds ONE reply, never a whole conversation — a dialogue case of
 * six turns is allowed six of these — so the sentence around it says "per turn"
 * (invariant 9's other half: a budget nobody can read is a budget nobody can
 * check).
 */
function timeoutSeconds(value: unknown): string {
	const milliseconds = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "—";
	return String(Math.round(milliseconds / 1_000));
}

/**
 * What the run will cost and how long it will take — or, once, that nothing
 * comparable has run yet.
 *
 * Money and time are estimated apart and say "unknown" in the same words, so
 * the first run of a project drew `Оценка неизвестно · сравнимых прогонов ещё
 * не … · неизвестно · сравнимых прогонов ещё не …`: the same sentence twice,
 * both halves overflowing the line. When neither is known there is one fact,
 * and it is said once.
 */
function estimateLine(cost: unknown, time: unknown, paint: Paint): string {
	const unknown = `${t("estimate.unknown")} ${t("estimate.nothing-comparable")}`;
	const label = paint.dim(t("label.estimate"));
	if (typeof cost === "string" && typeof time === "string" && cost === unknown && time === unknown) {
		return `${label} ${paint.muted(t("estimate.nothing-comparable-alone"))}`;
	}
	return `${label} ${text(cost, 60)} ${paint.dim("·")} ${text(time, 60)}`;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isCandidateSummary(value: unknown): value is WorkbenchCandidateSummary {
	const candidate = bag(value);
	return typeof candidate.candidateId === "string" && typeof candidate.status === "string" && typeof candidate.baseline === "object";
}

/** Generic, bounded key/value listing for subjects without a dedicated renderer. */
function describe(value: unknown, paint: Paint, indent = "  ", depth = 0): string[] {
	const lines: string[] = [];
	for (const [key, item] of Object.entries(bag(value))) {
		if (item === null || item === undefined) continue;
		if (Array.isArray(item)) {
			lines.push(`${indent}${paint.dim(key)} ${paint.dim(`(${plural(item.length, "item")})`)}`);
			lines.push(...item.slice(0, 8).map((entry) => `${indent}  • ${text(entry, 120)}`));
			if (item.length > 8) lines.push(`${indent}  ${paint.dim(t("dialog.more", { count: item.length - 8 }))}`);
		} else if (typeof item === "object") {
			if (depth >= 1) {
				lines.push(`${indent}${paint.dim(key)} ${text(item, 120)}`);
			} else {
				lines.push(`${indent}${paint.dim(key)}`);
				lines.push(...describe(item, paint, `${indent}  `, depth + 1));
			}
		} else {
			lines.push(`${indent}${paint.dim(key)} ${text(item)}`);
		}
	}
	return lines;
}

function specLines(spec: unknown, paint: Paint): string[] {
	const value = bag(spec);
	return [
		`${paint.dim(t("dialog.title"))} ${paint.bold(text(value.title, 120))}`,
		...wrap(typeof value.purpose === "string" ? value.purpose : "", 92, "  "),
		`${paint.dim(t("dialog.users"))} ${strings(value.users).map((item) => oneLine(item, 40)).join(", ") || "—"}`,
		`${paint.dim(t("dialog.jobs"))} ${plural(strings(value.jobs).length, "job")} ${paint.dim("·")} ${paint.dim(t("dialog.success-criteria"))} ${strings(value.successCriteria).length} ${paint.dim("·")} ${paint.dim(t("dialog.constraints"))} ${strings(value.constraints).length}`,
		...(strings(value.openQuestions).length > 0 ? [paint.warning(t("dialog.open-questions", { count: strings(value.openQuestions).length }))] : []),
	];
}

/** Operator-facing name for one planned sub-decision of a composite. */
function stepLabel(step: string): string {
	switch (step) {
		case "approve-spec": return t("confirm.step.approve-spec");
		case "publish-corpus": return t("confirm.step.publish-corpus");
		case "run-eval": return t("confirm.step.run-eval");
		case "review-candidate": return t("confirm.step.review-candidate");
		case "promote-candidate": return t("confirm.step.promote-candidate");
		case "adopt-candidate": return t("confirm.step.adopt-candidate");
		case "continue-cycle": return t("confirm.step.continue-cycle");
		default: return step;
	}
}

/**
 * How far the judge behind this evidence has been checked against a human. The
 * operator sees it BEFORE confirming a ship: promotion can refuse on it, and a
 * number nobody has checked is the one thing a verdict cannot tell you.
 */
function judgeCalibrationLines(candidate: WorkbenchCandidateSummary, paint: Paint): string[] {
	if (candidate.judgeAgreement === undefined) return [];
	if (candidate.judgeAgreement === null) {
		return [`${paint.dim(t("label.judge-instrument"))} ${paint.warning(t("judge.not-calibrated"))} ${paint.dim(t("judge.label-hint-long"))}`];
	}
	const { agreement, kappa, labels } = candidate.judgeAgreement;
	const kappaText = kappa === null ? "κ —" : `κ ${kappa.toFixed(2)}`;
	return [`${paint.dim(t("label.judge-instrument"))} ${t("judge.agreement", { rate: `${Math.round(agreement * 100)}%` })} ${paint.dim(`· ${kappaText} · n=${labels}`)}`];
}

/**
 * The check this change is going to need, priced before it is applied. Money
 * is one question per cycle: approving the diff approves the measurement that
 * follows it, so the amount belongs on the same screen as the diff.
 */
/** Diff lines the apply dialog shows inline before anyone says yes. */
const APPLY_PROPOSAL_DIFF_LINES = 120;

function verificationLine(estimate: WorkbenchRunEstimate | undefined, paint: Paint): string {
	const covenant = paint.dim(t("estimate.covenant"));
	if (!estimate || estimate.costUsd === null || estimate.minutes === null) {
		return `${paint.dim(t("label.verification"))} ${paint.warning(t("estimate.unknown"))} ${
			paint.dim(t("estimate.nothing-comparable"))
		} ${covenant}`;
	}
	const cost = estimate.costUsd < 0.01 ? t("estimate.under-cent") : t("estimate.about-cost", { cost: estimate.costUsd.toFixed(2) });
	const minutes = Math.ceil(estimate.minutes);
	const time = estimate.minutes < 1 ? t("estimate.under-minute") : t("estimate.about-minutes", { minutes: plural(minutes, "estimated minute") });
	return `${paint.dim(t("label.verification"))} ${cost} ${paint.dim("·")} ${time} ${covenant}`;
}

function subjectLines(confirmation: WorkbenchConfirmation, paint: Paint): string[] {
	const subject = bag(confirmation.subject);
	switch (confirmation.kind) {
		case "scaffold-target": {
			const files = Array.isArray(subject.templateFiles) ? subject.templateFiles : [];
			return [
				`${paint.dim(t("dialog.directory"))} ${text(subject.targetPath, 120)}`,
				`${paint.dim(t("dialog.files"))} ${t("dialog.starter-template", { files: plural(files.length, "file") })}`,
				...numbered(files.map((file) => text(bag(file).path ?? file, 80)), paint, { limit: 12 }),
			];
		}
		case "wrap-target": {
			const files = Array.isArray(subject.templateFiles) ? subject.templateFiles : [];
			const found = bag(subject.found);
			const command = Array.isArray(bag(subject.manifest).execution)
				? []
				: bag(bag(bag(subject.manifest).execution).command).argv;
			return [
				`${paint.dim(t("dialog.directory"))} ${text(subject.targetPath, 120)}`,
				`${paint.dim(t("result.agent-entry"))} ${text(found.entry, 80)}${Array.isArray(command) ? ` · ${text(command.join(" "), 80)}` : ""}`,
				`${paint.dim(t("result.agent-harness"))} ${text((bag(bag(subject.manifest).harness).files as string[] | undefined)?.join(", "), 80)}`,
				`${paint.dim(t("dialog.files"))} ${plural(files.length, "file")}`,
				...numbered(files.map((file) => text(bag(file).path ?? file, 80)), paint, { limit: 12 }),
			];
		}
		case "configure-target": {
			const next = bag(subject.next);
			const model = bag(next.model ?? subject.model);
			const lines = [
				`${paint.dim(t("dialog.target-id"))} ${paint.bold(text(next.targetId ?? subject.targetId, 80))}`,
				`${paint.dim(t("label.model"))} ${text(model.provider)}/${text(model.id)} ${paint.dim(t("dialog.model-detail", { thinking: text(model.thinkingLevel), seconds: timeoutSeconds(model.timeoutMs) }))}`,
				`${paint.dim(t("dialog.credential-env"))} ${paint.bold(text(model.apiKeyEnv))} ${paint.dim(t("dialog.name-only"))}`,
			];
			const diff = typeof subject.unifiedDiff === "string"
				? subject.unifiedDiff
				: typeof next.manifestDiff === "string" ? next.manifestDiff : typeof subject.diff === "string" ? subject.diff : null;
			if (diff) lines.push(paint.dim(t("dialog.manifest-diff")), ...renderUnifiedDiff(diff, paint, { maxLines: 80 }));
			else lines.push(paint.warning(t("dialog.manifest-diff-missing")));
			return lines;
		}
		case "configure-evaluators": {
			const next = bag(subject.next);
			const previous = bag(subject.previous);
			const targetModel = bag(subject.targetModel);
			const lines = [
				`${paint.dim(t("dialog.target-model"))} ${text(targetModel.provider)}/${text(targetModel.id)} ${
					paint.dim(t("dialog.judge-not-this-model"))
				}`,
			];
			for (const role of ["judge", "simulatedUser"] as const) {
				const label = t(role === "judge" ? "label.judge-instrument" : "result.simulated-user");
				const after = next[role];
				if (!after) {
					lines.push(`${paint.dim(label)} ${paint.muted(t("dialog.not-configured"))}`);
					continue;
				}
				const model = bag(after);
				const before = previous[role] ? bag(previous[role]) : null;
				const change = before && `${text(before.provider)}/${text(before.id)}` !== `${text(model.provider)}/${text(model.id)}`
					? ` ${paint.dim(t("dialog.was", { model: `${text(before.provider)}/${text(before.id)}` }))}`
					: "";
				lines.push(
					`${paint.dim(label)} ${text(model.provider)}/${text(model.id)}${change} ${
						paint.dim(t("dialog.model-detail", { thinking: text(model.thinkingLevel), seconds: timeoutSeconds(model.timeoutMs) }))
					}`,
					`${paint.dim(`  ${t("dialog.credential-env")}`)} ${paint.bold(text(model.apiKeyEnv))} ${
						paint.dim(t("dialog.name-only"))
					}`,
				);
			}
			const diff = typeof subject.unifiedDiff === "string" ? subject.unifiedDiff : null;
			if (diff) lines.push(paint.dim(t("dialog.manifest-diff")), ...renderUnifiedDiff(diff, paint, { maxLines: 80 }));
			else lines.push(paint.warning(t("dialog.manifest-diff-missing")));
			return lines;
		}
		case "start-testing": {
			const steps = strings(subject.steps);
			return [
				`${paint.dim(t("label.spec"))} ${text(subject.spec, 96)}`,
				`${paint.dim(t("label.basket"))} ${text(subject.basket, 96)}`,
				// The evaluator models the host pre-filled, named where the operator
				// approves them. Absent lines mean this basket needs neither, or the
				// Target already carries one — invariant 40 either way: the model and
				// the variable NAME are what is being approved, never a key value.
				...(subject.judge === undefined ? [] : [`${paint.dim(t("label.judge-instrument"))} ${text(subject.judge, 96)}`]),
				...(subject.user === undefined ? [] : [`${paint.dim(t("label.user-instrument"))} ${text(subject.user, 96)}`]),
				`${paint.dim(t("label.run"))} ${text(subject.run, 96)}`,
				// The per-turn budget, where the run it bounds is approved.
				...(typeof subject.budget === "string" ? [`${paint.dim(t("label.budget"))} ${text(subject.budget, 96)}`] : []),
				estimateLine(subject.estimatedCost, subject.estimatedTime, paint),
				"",
				paint.dim(t("confirm.covers")),
				...bullets(steps.map((step) => stepLabel(step)), paint),
				paint.muted(t("confirm.step-record")),
			];
		}
		case "improve": {
			const authoring = bag(subject.authoringBudget);
			const maxVariants = Number(authoring.maxVariants ?? 0);
			const maxRequests = typeof authoring.maxRequests === "number" ? authoring.maxRequests : null;
			const maxOutputTokens = typeof authoring.maxOutputTokens === "number" ? authoring.maxOutputTokens : null;
			const maxCostUsd = typeof authoring.maxCostUsd === "number" ? authoring.maxCostUsd : null;
			const authorCost = maxCostUsd === null
				? t("estimate.unknown")
				: maxCostUsd < 0.01
					? t("estimate.under-cent")
					: t("estimate.about-cost", { cost: maxCostUsd.toFixed(2) });
			const authorBudget = maxRequests === null || maxOutputTokens === null
				? t("confirm.improve.builder-budget-unknown", { variants: maxVariants })
				: t("confirm.improve.builder-budget", {
					variants: maxVariants,
					requests: maxRequests,
					tokens: maxOutputTokens,
				});
			return [
				`${paint.dim(t("confirm.improve.target-subtotal"))} ${text(subject.targetEstimatedCost, 100)}`,
				`${paint.dim(t("confirm.improve.builder-ceiling"))} ${authorCost} ${paint.dim(`· ${authorBudget}`)}`,
				`${paint.dim(t("confirm.improve.total"))} ${text(subject.estimatedCost, 100)} ${paint.dim("·")} ${text(subject.estimatedTime, 80)}`,
				...wrap(text(subject.authoring, 500), 92, "  ").map((line) => paint.muted(line)),
			];
		}
		case "ship": {
			const steps = strings(subject.steps);
			const candidate = subject.candidate;
			const diff = subject.diff === null || subject.diff === undefined ? null : bag(subject.diff);
			const exactDiff = typeof diff?.exactDiff === "string" ? diff.exactDiff : "";
			return [
				// The measurement sentence the operator just read on the panel, whole:
				// the last gate before a release is the worst place to cut a number.
				`${paint.dim(t("label.development"))} ${text(subject.development, 200)}`,
				// The last screen before a release says what the exam showed, not
				// only that it passed: `pass` covers both findings.
				`${paint.dim(t("label.sealed"))} ${text(subject.sealed, 96)}${sealedOutcomeSuffix(subject.sealedOutcome)}`,
				// The diff summary belongs BEFORE the yes: a loop-applied candidate was
				// never shown file by file, and this is the last chance to see what it is.
				// Bounded like the apply dialog, though: an eleven-file diff drawn in
				// full made the dialog taller than the terminal, and the TUI repainted
				// the whole transcript every frame until the operator pressed Escape.
				// /review shows the exact remainder.
				...(diff
					? [
						`${paint.dim(t("label.diff"))} ${paint.bold(plural(Number(diff.files ?? 0), "file"))} ${paint.dim("·")} ` +
							`${text(strings(diff.paths).join(", "), 96)}`,
						diff.via === "improvement-loop" || diff.via === "proposal-search"
							? `${paint.dim(t("label.applied"))} ${paint.warning(t(diff.via === "improvement-loop" ? "candidate.applied-by-loop" : "candidate.applied-by-search"))} ${paint.dim(t("candidate.applied-automated", { actor: text(diff.appliedBy, 40) }))}`
							: `${paint.dim(t("label.applied"))} ${paint.dim(t("candidate.applied-reviewed", { actor: text(diff.appliedBy, 40) }))}`,
						...(exactDiff
							? [paint.dim(t("confirm.ship.exact-diff", { hash: shortHash(text(diff.proposalHash, 80)) })), ...renderUnifiedDiff(exactDiff, paint, { maxLines: APPLY_PROPOSAL_DIFF_LINES, remainder: t("confirm.apply-remainder") })]
							: [paint.warning(t("confirm.ship.no-exact-diff"))]),
					]
					: []),
				...(isCandidateSummary(candidate) ? judgeCalibrationLines(candidate, paint) : []),
				`${paint.dim(t("label.version"))} ${subject.tag ? paint.bold(text(subject.tag, 40)) : paint.warning(t("confirm.ship.already-promoted"))}`,
				`${paint.dim(t("label.branch"))} ${text(subject.fastForward, 96)}`,
				"",
				paint.dim(t("confirm.covers")),
				...bullets(steps.map((step) => stepLabel(step)), paint),
				...(isCandidateSummary(candidate) ? ["", ...renderCandidate(candidate, paint)] : []),
			];
		}
		case "approve-spec":
			return [
				`${paint.dim(t("section.spec-draft"))} ${text(subject.draftSpecId)} ${paint.dim(`· ${shortHash(text(subject.draftSnapshotHash))}`)}`,
				...specLines(subject.spec, paint),
				paint.muted(t("dialog.approve-freezes")),
			];
		case "publish-corpus": {
			const publication = bag(subject.publication);
			const tasks = Array.isArray(subject.tasks) ? subject.tasks : [];
			return [
				`${paint.dim(t("label.basket"))} ${paint.bold(text(publication.name, 80))} ${paint.dim(`· ${plural(Number(publication.taskCount ?? tasks.length), "case")} · ${shortHash(text(publication.contentHash))}`)}`,
				...numbered(tasks.map((task) => text(bag(task).input ?? task, 96)), paint, { limit: 10 }),
				paint.muted(t("dialog.publish-note")),
			];
		}
		/**
		 * Four facts and, on the draft path, a fifth: how many cases and which
		 * model writes them, what it is given, that none of it comes back, and
		 * what it costs. Every one of them is in the subject the hash covers, and
		 * none of them is a case — the exam does not exist yet, and when it does
		 * this dialog is not where it appears.
		 */
		case "generate-holdout": {
			const cases = Number(subject.requested ?? 0);
			const examples = Number(subject.examples ?? 0);
			const cost = Number(subject.estimatedCostUsd ?? 0);
			const lines = [
				`${paint.dim(t("label.exam"))} ${paint.bold(t("generate-holdout.by-judge", {
					cases: plural(cases, "case"),
					generator: text(subject.generatorModel, 80),
				}))}`,
				`${paint.dim(t("label.source"))} ${subject.source === "kb"
					// How many passages the judge is shown; the line above already
					// carries how many questions come back out of them.
					? t("generate-holdout.source-kb", {
						chunks: plural(Array.isArray(subject.kbChunkIds) ? subject.kbChunkIds.length : 0, "passage"),
					})
					: examples > 0
					? t("generate-holdout.source", { examples: plural(examples, "example") })
					: t("generate-holdout.source-spec-only")}`,
				paint.muted(t("generate-holdout.blind")),
				`${paint.dim(t("label.cost"))} ${cost >= 0.005 ? `~$${cost.toFixed(2)}` : "<$0.01"}`,
			];
			if (subject.mode === "review") lines.push(paint.warning(t("generate-holdout.draft")));
			return lines;
		}
		case "import-dataset": {
			const sealed = subject.sealed === null || subject.sealed === undefined ? null : bag(subject.sealed);
			const recipe = bag(subject.recipe);
			const input = bag(recipe.input);
			const mapping = [
				`input ${input.column ? `← ${text(input.column, 40)}` : input.template ? `← ${t("dialog.template", { name: text(input.template, 60) })}` : recipe.dialogue ? `← ${t("dialog.last-user-turn")}` : "—"}`,
				...(recipe.expected ? [`expected ← ${text(bag(recipe.expected).column, 40)}`] : []),
				...(recipe.dialogue ? [`dialogue ← ${text(bag(recipe.dialogue).column, 40)}`] : []),
				...(strings(recipe.metadata).length > 0 ? [`metadata ← ${strings(recipe.metadata).map((item) => oneLine(item, 24)).join(", ")}`] : []),
			];
			const cases = Array.isArray(subject.sampleCases) ? subject.sampleCases : [];
			const lines = [
				`${paint.dim(t("dialog.file"))} ${paint.bold(text(subject.sourcePath, 60))} ${paint.dim(t("dialog.basket-inline"))} ${text(subject.name, 30)}`,
				`${paint.dim(t("dialog.mapping"))} ${oneLine(mapping.join(" · "), 100)}`,
				`${paint.dim(t("dialog.cases"))} ${paint.bold(plural(Number(subject.developmentCount ?? cases.length), "development case"))}` +
					`${Number(subject.skippedRows ?? 0) > 0 ? ` ${paint.dim(t("card.skipped", { rows: plural(Number(subject.skippedRows), "row") }))}` : ""}`,
				sealed
					? `${paint.dim(t("label.sealed"))} ${t("dialog.sealed-drawn", { rows: paint.bold(plural(Number(sealed.count ?? 0), "row")), seed: paint.bold(text(sealed.seed, 24)) })}${sealed.stratifyBy ? ` ${paint.dim(t("dialog.stratified", { column: text(sealed.stratifyBy, 20) }))}` : ""}`
					: `${paint.dim(t("label.sealed"))} ${paint.warning(t("dialog.none"))} ${paint.dim(t("dialog.sealed-none-note"))}`,
			];
			if (cases.length > 0) {
				lines.push(paint.dim(t("dialog.sample-cases")), ...renderDatasetCases(cases as WorkbenchDatasetCase[], paint));
			}
			lines.push(paint.muted(t("dialog.sealed-first")));
			return lines;
		}
		case "run-eval": {
			const target = bag(subject.target);
			const corpus = bag(subject.developmentCorpus);
			const tasks = Number(subject.taskCount ?? 0);
			const repetitions = Number(subject.repetitions ?? 1);
			return [
				`${paint.dim(t("label.run"))} ${t("confirm.start-testing.run", { cases: plural(tasks, "case"), repetitions: plural(repetitions, "repetition"), executions: paint.bold(plural(tasks * repetitions, "execution")) })} ${paint.dim(t("dialog.each-calls-target"))}`,
				`${paint.dim(t("section.target"))} ${text(target.id)} ${paint.dim(`@ ${shortSha(text(target.gitSha, 40))}`)} ${paint.dim(t("dialog.basket-inline"))} ${text(corpus.id)} ${paint.dim(`(${plural(Number(corpus.taskCount ?? tasks), "case")})`)}`,
			];
		}
		case "calibrate": {
			const corpus = bag(subject.developmentCorpus);
			const target = bag(subject.target);
			const tasks = Number(corpus.taskCount ?? 0);
			const repetitions = Number(subject.repetitions ?? 1);
			return [
				`${paint.dim(t("dialog.calibrate-noise"))} ${t("dialog.calibrate-twice")} ${paint.dim(t("dialog.nothing-promoted"))}`,
				`${paint.dim(t("label.cost"))} ${t("confirm.start-testing.run", { cases: plural(tasks, "case"), repetitions: plural(repetitions, "repetition"), executions: paint.bold(plural(2 * tasks * repetitions, "execution")) })} ${paint.dim(t("dialog.each-calls-target"))}`,
				`${paint.dim(t("section.target"))} ${text(target.id, 60)} ${paint.dim(`@ ${shortSha(text(target.gitSha, 40))}`)} ${paint.dim(t("dialog.basket-inline"))} ${text(corpus.id, 60)}`,
				paint.muted(t("dialog.aa-note")),
			];
		}
		case "tool-authoring": {
			const capabilities = bag(subject.capabilities);
			const credentials = Array.isArray(capabilities.credentials) ? capabilities.credentials.map(bag) : [];
			return [
				`${paint.dim(t("label.tool"))} ${paint.bold(text(subject.tool, 64))}`,
				...wrap(text(subject.purpose, 2_000), 92, "  "),
				`${paint.dim(t("label.data-source"))} ${text(subject.dataSource, 120)}`,
				...renderToolPermissions([{
					tool: text(subject.tool, 64),
					removed: false,
					network: capabilities.network === "allow" ? "allow" : "deny",
					filesystem: capabilities.filesystem === "workspace-write" ? "workspace-write" : "read-only",
					environment: credentials.map((entry) => text(entry.environment, 60)),
					...(subject.setup ? { setup: { network: bag(subject.setup).network === "allow" ? "allow" : "deny" } } : { setup: null }),
				}], paint),
				`${paint.dim(t("label.package"))} ${plural(strings(subject.files).length, "file")} ${paint.dim(`· ${t("label.contract-tests")}`)} ${strings(subject.contractTests).join(", ")}`,
				paint.muted(t("confirm.tool-authoring.secrets")),
			];
		}
		case "apply-proposal": {
			const diff = typeof subject.exactDiff === "string" ? subject.exactDiff : "";
			const stats = diffStats(diff);
			// The promise the operator is approving, on the screen where they say yes.
			const prediction = predictionOf(subject.prediction);
			return [
				`${paint.dim(t("label.branch"))} ${paint.bold(text(subject.branch, 80))} ${paint.dim(`· ${t("label.base")}`)} ${shortSha(text(subject.baseTargetSha, 40))}`,
				...wrap(typeof subject.summary === "string" ? subject.summary : "", 92, "  "),
				`${paint.dim(t("label.changes"))} ${strings(subject.paths).map((path) => oneLine(path, 60)).join(", ") || "—"} ${paint.dim(`(${paint.added(`+${stats.added}`)} ${paint.removed(`-${stats.removed}`)})`)}`,
				// Applying a tool is the durable moment its authority becomes real, so
				// the block says what it reaches before the yes, not only inside YAML.
				...renderToolPermissions(toolPermissionsFromDiff(diff), paint),
				predictionPromiseLine(prediction, paint) ?? predictionAbsentLine(paint),
				...(predictionNoteLine(prediction, paint) ? [predictionNoteLine(prediction, paint)!] : []),
				verificationLine(confirmation.estimate, paint),
				...(strings(subject.risks).length > 0 ? [paint.warning(t("label.risks")), ...bullets(strings(subject.risks), paint, { limit: 5 })] : []),
				// The diff itself, here, before the yes — /review is a second look at
				// it, never the only one.
				paint.dim(t("label.diff")),
				...renderUnifiedDiff(diff, paint, {
					maxLines: APPLY_PROPOSAL_DIFF_LINES,
					remainder: t("confirm.apply-remainder"),
				}),
				paint.muted(t("confirm.apply-checkout")),
			];
		}
		case "discard-proposal":
			return [...describe(subject.subject ?? subject, paint), paint.muted(t("dialog.discard-note"))];
		case "verify-candidate": {
			const holdout = bag(subject.sealedHoldout);
			const development = bag(subject.developmentCorpus);
			const repetitions = Number(subject.repetitions ?? 1);
			return [
				`${paint.dim(t("dialog.matched-experiment"))} ${t("dialog.matched-detail", { baseline: shortSha(text(subject.baseTargetSha, 40)), candidate: paint.bold(shortSha(text(subject.candidateSha, 40))) })} ${paint.dim(`· ${plural(repetitions, "repetition")}`)}`,
				// The count first: this is the number of the operator's own cases both
				// arms will run, and reading it here is how they catch a basket that is
				// not the one they wrote.
				`${paint.dim(t("dialog.development-basket"))} ${development.id
					? `${plural(Number(development.taskCount ?? 0), "case")} ${paint.dim(`· ${text(development.id)} (${shortHash(text(development.hash))})`)}`
					: paint.muted(t("dialog.none"))}`,
				`${paint.dim(t("label.sealed-holdout"))} ${plural(Number(holdout.taskCount ?? 0), "case")} ${paint.dim(t("dialog.sealed-identity"))}`,
				paint.muted(t("dialog.both-revisions")),
			];
		}
		case "abandon-candidate":
		case "review-candidate":
		case "promote-candidate":
		case "reject-candidate":
		case "adopt-candidate":
		case "continue-cycle": {
			const proposal = subject.proposal === null || subject.proposal === undefined
				? null
				: subject.proposal as WorkbenchProposalReview;
			const lines = isCandidateSummary(subject.candidate)
				? renderCandidate({ ...subject.candidate, proposal }, paint)
				: describe(subject.candidate, paint);
			if (confirmation.kind === "review-candidate") lines.push(`${paint.dim(t("label.recommendation"))} ${paint.bold(text(subject.recommendation))}`);
			if (confirmation.kind === "promote-candidate") lines.push(`${paint.dim(t("label.tag"))} ${paint.success(text(subject.tag))} ${paint.dim(t("dialog.annotated-tag"))}`);
			if (confirmation.kind === "adopt-candidate") {
				const adoption = bag(subject.adoption);
				const branch = bag(adoption.branch);
				const revision = bag(bag(adoption.candidate).revision);
				const baseline = bag(bag(adoption.candidate).baseline);
				const changed = strings(bag(adoption.candidate).changedFiles);
				lines.push(`${paint.dim(t("dialog.fast-forward"))} ${t("result.branch")} ${paint.bold(text(branch.name))} ${shortSha(text(baseline.sha, 40))} → ${paint.success(shortSha(text(revision.sha, 40)))}`);
				lines.push(`${paint.dim(t("dialog.changed-files"))} ${changed.map((path) => oneLine(path, 60)).join(", ") || "—"}`);
				lines.push(paint.muted(t("dialog.fast-forward-note")));
			}
			if (confirmation.kind === "continue-cycle") {
				const continuation = bag(subject.continuation);
				lines.push(`${paint.dim(t("dialog.active-target"))} ${shortSha(text(continuation.activeTargetSha, 40))} ${paint.dim("·")} ${text(continuation.branchRef)}`);
				lines.push(paint.muted(t("dialog.close-cycle-note")));
			}
			if (confirmation.kind === "abandon-candidate") lines.push(paint.muted(t("dialog.abandon-note")));
			return lines;
		}
		default:
			return describe(subject, paint);
	}
}

/** Kinds whose subject is a computation, not an artifact: the hash adds nothing for a human. */
const EPHEMERAL_SUBJECTS = new Set<WorkbenchConfirmation["kind"]>(["run-eval", "verify-candidate", "run-current", "calibrate"]);

/** Human-readable confirmation body: what will happen, exact subject, reason, hash. */
export function renderConfirmation(confirmation: WorkbenchConfirmation, paint: Paint): string[] {
	return [
		...subjectLines(confirmation, paint),
		"",
		`${paint.dim(t("label.reason"))} ${clean(oneLine(confirmation.reason, 300))}`,
		...(EPHEMERAL_SUBJECTS.has(confirmation.kind) ? [] : [`${paint.dim(t("label.exact-subject"))} ${paint.dim(confirmation.subjectHash)}`]),
	];
}
