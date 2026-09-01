import type { WorkbenchRunEstimate } from "../../workbench/transition-policy.js";
import type {
	WorkbenchCandidateSummary,
	WorkbenchConfirmation,
	WorkbenchDatasetCase,
	WorkbenchProposalReview,
} from "../../workbench/types.js";
import { diffStats, renderUnifiedDiff } from "./diff.js";
import { bullets, clean, numbered, oneLine, pluralize, shortHash, shortSha, wrap } from "./format.js";
import type { Paint } from "./paint.js";
import { renderCandidate, renderDatasetCases } from "./view.js";

type Bag = Record<string, unknown>;

function bag(value: unknown): Bag {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Bag) : {};
}

function text(value: unknown, max = 160): string {
	if (typeof value === "string") return oneLine(value, max);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value === null || value === undefined) return "—";
	return oneLine(JSON.stringify(value), max);
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
			lines.push(`${indent}${paint.dim(key)} ${paint.dim(`(${pluralize(item.length, "item")})`)}`);
			lines.push(...item.slice(0, 8).map((entry) => `${indent}  • ${text(entry, 120)}`));
			if (item.length > 8) lines.push(`${indent}  ${paint.dim(`… +${item.length - 8} more`)}`);
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
		`${paint.dim("Title")} ${paint.bold(text(value.title, 120))}`,
		...wrap(typeof value.purpose === "string" ? value.purpose : "", 92, "  "),
		`${paint.dim("Users")} ${strings(value.users).map((item) => oneLine(item, 40)).join(", ") || "—"}`,
		`${paint.dim("Jobs")} ${pluralize(strings(value.jobs).length, "job")} ${paint.dim("·")} ${paint.dim("success criteria")} ${strings(value.successCriteria).length} ${paint.dim("·")} ${paint.dim("constraints")} ${strings(value.constraints).length}`,
		...(strings(value.openQuestions).length > 0 ? [paint.warning(`Open questions: ${strings(value.openQuestions).length}`)] : []),
	];
}

/** Operator-facing name for one planned sub-decision of a composite. */
function stepLabel(step: string): string {
	switch (step) {
		case "approve-spec": return "approve the Spec draft";
		case "publish-corpus": return "publish the eval basket";
		case "run-eval": return "run the basket against the Target";
		case "review-candidate": return "record the review";
		case "promote-candidate": return "tag the reviewed revision";
		case "adopt-candidate": return "fast-forward this branch to it";
		case "continue-cycle": return "close the cycle";
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
		return [`${paint.dim("Judge")} ${paint.warning("not calibrated")} ${paint.dim("· ahde label checks it against your own eyes")}`];
	}
	const { agreement, kappa, labels } = candidate.judgeAgreement;
	const kappaText = kappa === null ? "κ —" : `κ ${kappa.toFixed(2)}`;
	return [`${paint.dim("Judge")} agreement ${Math.round(agreement * 100)}% ${paint.dim(`· ${kappaText} · n=${labels}`)}`];
}

/**
 * The check this change is going to need, priced before it is applied. Money
 * is one question per cycle: approving the diff approves the measurement that
 * follows it, so the amount belongs on the same screen as the diff.
 */
function verificationLine(estimate: WorkbenchRunEstimate | undefined, paint: Paint): string {
	const covenant = paint.dim("— approving this change also approves that measurement");
	if (!estimate || estimate.costUsd === null || estimate.minutes === null) {
		return `${paint.dim("Verification")} ${paint.warning("unknown")} ${
			paint.dim("· nothing comparable has run yet")
		} ${covenant}`;
	}
	const cost = estimate.costUsd < 0.01 ? "under $0.01" : `about $${estimate.costUsd.toFixed(2)}`;
	const minutes = Math.ceil(estimate.minutes);
	const time = estimate.minutes < 1 ? "under a minute" : `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
	return `${paint.dim("Verification")} ${cost} ${paint.dim("·")} ${time} ${covenant}`;
}

function subjectLines(confirmation: WorkbenchConfirmation, paint: Paint): string[] {
	const subject = bag(confirmation.subject);
	switch (confirmation.kind) {
		case "scaffold-target": {
			const files = Array.isArray(subject.templateFiles) ? subject.templateFiles : [];
			return [
				`${paint.dim("Directory")} ${text(subject.targetPath, 120)}`,
				`${paint.dim("Files")} ${pluralize(files.length, "file")} from the trusted starter template, plus a fresh Git repository with one commit`,
				...numbered(files.map((file) => text(bag(file).path ?? file, 80)), paint, { limit: 12 }),
			];
		}
		case "configure-target": {
			const next = bag(subject.next);
			const model = bag(next.model ?? subject.model);
			const lines = [
				`${paint.dim("Target id")} ${paint.bold(text(next.targetId ?? subject.targetId, 80))}`,
				`${paint.dim("Model")} ${text(model.provider)}/${text(model.id)} ${paint.dim(`· thinking ${text(model.thinkingLevel)} · timeout ${text(model.timeoutMs)} ms`)}`,
				`${paint.dim("Credential env")} ${paint.bold(text(model.apiKeyEnv))} ${paint.dim("(name only; set the value in your shell)")}`,
			];
			const diff = typeof subject.unifiedDiff === "string"
				? subject.unifiedDiff
				: typeof next.manifestDiff === "string" ? next.manifestDiff : typeof subject.diff === "string" ? subject.diff : null;
			if (diff) lines.push(paint.dim("manifest.yaml diff"), ...renderUnifiedDiff(diff, paint, { maxLines: 80 }));
			else lines.push(paint.warning("manifest.yaml diff is not available in this subject"));
			return lines;
		}
		case "configure-evaluators": {
			const next = bag(subject.next);
			const previous = bag(subject.previous);
			const targetModel = bag(subject.targetModel);
			const lines = [
				`${paint.dim("Target model")} ${text(targetModel.provider)}/${text(targetModel.id)} ${
					paint.dim("· the judge may not be this model")
				}`,
			];
			for (const role of ["judge", "simulatedUser"] as const) {
				const label = role === "judge" ? "Judge" : "Simulated user";
				const after = next[role];
				if (!after) {
					lines.push(`${paint.dim(label)} ${paint.muted("not configured")}`);
					continue;
				}
				const model = bag(after);
				const before = previous[role] ? bag(previous[role]) : null;
				const change = before && `${text(before.provider)}/${text(before.id)}` !== `${text(model.provider)}/${text(model.id)}`
					? ` ${paint.dim(`(was ${text(before.provider)}/${text(before.id)})`)}`
					: "";
				lines.push(
					`${paint.dim(label)} ${text(model.provider)}/${text(model.id)}${change} ${
						paint.dim(`· thinking ${text(model.thinkingLevel)} · timeout ${text(model.timeoutMs)} ms`)
					}`,
					`${paint.dim("  Credential env")} ${paint.bold(text(model.apiKeyEnv))} ${
						paint.dim("(name only; set the value in your shell)")
					}`,
				);
			}
			const diff = typeof subject.unifiedDiff === "string" ? subject.unifiedDiff : null;
			if (diff) lines.push(paint.dim("manifest.yaml diff"), ...renderUnifiedDiff(diff, paint, { maxLines: 80 }));
			else lines.push(paint.warning("manifest.yaml diff is not available in this subject"));
			return lines;
		}
		case "start-testing": {
			const steps = strings(subject.steps);
			return [
				`${paint.dim("Spec")} ${text(subject.spec, 96)}`,
				`${paint.dim("Basket")} ${text(subject.basket, 96)}`,
				`${paint.dim("Run")} ${text(subject.run, 96)}`,
				`${paint.dim("Estimate")} ${text(subject.estimatedCost, 40)} ${paint.dim("·")} ${text(subject.estimatedTime, 40)}`,
				"",
				paint.dim("This one confirmation covers:"),
				...bullets(steps.map((step) => stepLabel(step)), paint),
				paint.muted("Each step still writes its own durable record; the first one that fails stops the rest."),
			];
		}
		case "ship": {
			const steps = strings(subject.steps);
			const candidate = subject.candidate;
			const diff = subject.diff === null || subject.diff === undefined ? null : bag(subject.diff);
			const exactDiff = typeof diff?.exactDiff === "string" ? diff.exactDiff : "";
			return [
				`${paint.dim("Development")} ${text(subject.development, 96)}`,
				`${paint.dim("Sealed")} ${text(subject.sealed, 96)}`,
				// The diff summary belongs BEFORE the yes: a loop-applied candidate was
				// never shown file by file, and this is the last chance to see what it is.
				...(diff
					? [
						`${paint.dim("Diff")} ${paint.bold(pluralize(Number(diff.files ?? 0), "file"))} ${paint.dim("·")} ` +
							`${text(strings(diff.paths).join(", "), 96)}`,
						diff.via === "improvement-loop" || diff.via === "proposal-search"
							? `${paint.dim("Applied")} ${paint.warning(`by the ${diff.via === "improvement-loop" ? "improvement loop" : "proposal search"}`)} ${paint.dim(`— ${text(diff.appliedBy, 40)} authorized the automated trial, not this individual diff`)}`
							: `${paint.dim("Applied")} ${paint.dim(`by ${text(diff.appliedBy, 40)}, who read this diff`)}`,
						...(exactDiff
							? [paint.dim(`Exact diff · ${shortHash(text(diff.proposalHash, 80))}`), ...renderUnifiedDiff(exactDiff, paint, { maxLines: Number.MAX_SAFE_INTEGER })]
							: [paint.warning("Exact diff is unavailable; do not ship this automated candidate")]),
					]
					: []),
				...(isCandidateSummary(candidate) ? judgeCalibrationLines(candidate, paint) : []),
				`${paint.dim("Version")} ${subject.tag ? paint.bold(text(subject.tag, 40)) : paint.warning("already promoted")}`,
				`${paint.dim("Branch")} ${text(subject.fastForward, 96)}`,
				"",
				paint.dim("This one confirmation covers:"),
				...bullets(steps.map((step) => stepLabel(step)), paint),
				...(isCandidateSummary(candidate) ? ["", ...renderCandidate(candidate, paint)] : []),
			];
		}
		case "approve-spec":
			return [
				`${paint.dim("Spec draft")} ${text(subject.draftSpecId)} ${paint.dim(`· ${shortHash(text(subject.draftSnapshotHash))}`)}`,
				...specLines(subject.spec, paint),
				paint.muted("Approval freezes this exact Spec; evaluation cases and proposals will cite it."),
			];
		case "publish-corpus": {
			const publication = bag(subject.publication);
			const tasks = Array.isArray(subject.tasks) ? subject.tasks : [];
			return [
				`${paint.dim("Basket")} ${paint.bold(text(publication.name, 80))} ${paint.dim(`· ${pluralize(Number(publication.taskCount ?? tasks.length), "case")} · ${shortHash(text(publication.contentHash))}`)}`,
				...numbered(tasks.map((task) => text(bag(task).input ?? task, 96)), paint, { limit: 10 }),
				paint.muted("Publishing makes these cases the development evidence for this Spec lineage."),
			];
		}
		case "import-dataset": {
			const sealed = subject.sealed === null || subject.sealed === undefined ? null : bag(subject.sealed);
			const recipe = bag(subject.recipe);
			const input = bag(recipe.input);
			const mapping = [
				`input ${input.column ? `← ${text(input.column, 40)}` : input.template ? `← template ${text(input.template, 60)}` : recipe.dialogue ? "← last user turn" : "—"}`,
				...(recipe.expected ? [`expected ← ${text(bag(recipe.expected).column, 40)}`] : []),
				...(recipe.dialogue ? [`dialogue ← ${text(bag(recipe.dialogue).column, 40)}`] : []),
				...(strings(recipe.metadata).length > 0 ? [`metadata ← ${strings(recipe.metadata).map((item) => oneLine(item, 24)).join(", ")}`] : []),
			];
			const cases = Array.isArray(subject.sampleCases) ? subject.sampleCases : [];
			const lines = [
				`${paint.dim("File")} ${paint.bold(text(subject.sourcePath, 60))} ${paint.dim("· basket")} ${text(subject.name, 30)}`,
				`${paint.dim("Mapping")} ${oneLine(mapping.join(" · "), 100)}`,
				`${paint.dim("Cases")} ${paint.bold(pluralize(Number(subject.developmentCount ?? cases.length), "development case"))}` +
					`${Number(subject.skippedRows ?? 0) > 0 ? ` ${paint.dim("·")} ${pluralize(Number(subject.skippedRows), "row")} skipped` : ""}`,
				sealed
					? `${paint.dim("Sealed")} ${paint.bold(pluralize(Number(sealed.count ?? 0), "row"))} drawn with seed ${paint.bold(text(sealed.seed, 24))}${sealed.stratifyBy ? paint.dim(` · stratified by ${text(sealed.stratifyBy, 20)}`) : ""}`
					: `${paint.dim("Sealed")} ${paint.warning("none")} ${paint.dim("· without a holdout there is no exam for this file")}`,
			];
			if (cases.length > 0) {
				lines.push(paint.dim("Sample cases"), ...renderDatasetCases(cases as WorkbenchDatasetCase[], paint));
			}
			lines.push(paint.muted("Sealed rows are compiled first and never enter a development case or your context."));
			return lines;
		}
		case "run-eval": {
			const target = bag(subject.target);
			const corpus = bag(subject.developmentCorpus);
			const tasks = Number(subject.taskCount ?? 0);
			const repetitions = Number(subject.repetitions ?? 1);
			return [
				`${paint.dim("Run")} ${pluralize(tasks, "case")} × ${pluralize(repetitions, "repetition")} = ${paint.bold(`${tasks * repetitions} Target executions`)} ${paint.dim("· each one calls the Target model")}`,
				`${paint.dim("Target")} ${text(target.id)} ${paint.dim(`@ ${shortSha(text(target.gitSha, 40))}`)} ${paint.dim("· basket")} ${text(corpus.id)} ${paint.dim(`(${pluralize(Number(corpus.taskCount ?? tasks), "case")})`)}`,
			];
		}
		case "calibrate": {
			const corpus = bag(subject.developmentCorpus);
			const target = bag(subject.target);
			const tasks = Number(corpus.taskCount ?? 0);
			const repetitions = Number(subject.repetitions ?? 1);
			return [
				`${paint.dim("Calibrate noise")} run this exact revision twice ${paint.dim("· nothing is promoted")}`,
				`${paint.dim("Cost")} ${pluralize(tasks, "case")} × ${pluralize(repetitions, "repetition")} = ${paint.bold(`${2 * tasks * repetitions} Target executions`)} ${paint.dim("· each one calls the Target model")}`,
				`${paint.dim("Target")} ${text(target.id, 60)} ${paint.dim(`@ ${shortSha(text(target.gitSha, 40))}`)} ${paint.dim("· basket")} ${text(corpus.id, 60)}`,
				paint.muted("A/A measures how much the agent disagrees with itself, so later deltas can be believed."),
			];
		}
		case "apply-proposal": {
			const diff = typeof subject.exactDiff === "string" ? subject.exactDiff : "";
			const stats = diffStats(diff);
			return [
				`${paint.dim("Branch")} ${paint.bold(text(subject.branch, 80))} ${paint.dim("· base")} ${shortSha(text(subject.baseTargetSha, 40))}`,
				...wrap(typeof subject.summary === "string" ? subject.summary : "", 92, "  "),
				`${paint.dim("Changes")} ${strings(subject.paths).map((path) => oneLine(path, 60)).join(", ") || "—"} ${paint.dim(`(${paint.added(`+${stats.added}`)} ${paint.removed(`-${stats.removed}`)} · full diff shown by /review)`)}`,
				verificationLine(confirmation.estimate, paint),
				...(strings(subject.risks).length > 0 ? [paint.warning("Risks"), ...bullets(strings(subject.risks), paint, { limit: 5 })] : []),
				paint.muted("Your checkout stays where it is; the proposal is committed on the candidate branch."),
			];
		}
		case "discard-proposal":
			return [...describe(subject.subject ?? subject, paint), paint.muted("Discarding is durable; the same proposal cannot be applied later.")];
		case "verify-candidate": {
			const holdout = bag(subject.sealedHoldout);
			const development = bag(subject.developmentCorpus);
			const repetitions = Number(subject.repetitions ?? 1);
			return [
				`${paint.dim("Matched experiment")} baseline ${shortSha(text(subject.baseTargetSha, 40))} vs candidate ${paint.bold(shortSha(text(subject.candidateSha, 40)))} ${paint.dim(`· ${pluralize(repetitions, "repetition")}`)}`,
				`${paint.dim("Development basket")} ${development.id ? `${text(development.id)} ${paint.dim(`(${shortHash(text(development.hash))})`)}` : paint.muted("none")}`,
				`${paint.dim("Sealed holdout")} ${pluralize(Number(holdout.taskCount ?? 0), "case")} ${paint.dim("· identity stays evaluator-only")}`,
				paint.muted("Both revisions run every case; the Builder never sees sealed content."),
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
			if (confirmation.kind === "review-candidate") lines.push(`${paint.dim("Recommendation")} ${paint.bold(text(subject.recommendation))}`);
			if (confirmation.kind === "promote-candidate") lines.push(`${paint.dim("Tag")} ${paint.success(text(subject.tag))} ${paint.dim("· annotated tag on the exact candidate revision")}`);
			if (confirmation.kind === "adopt-candidate") {
				const adoption = bag(subject.adoption);
				const branch = bag(adoption.branch);
				const revision = bag(bag(adoption.candidate).revision);
				const baseline = bag(bag(adoption.candidate).baseline);
				const changed = strings(bag(adoption.candidate).changedFiles);
				lines.push(`${paint.dim("Fast-forward")} branch ${paint.bold(text(branch.name))} ${shortSha(text(baseline.sha, 40))} → ${paint.success(shortSha(text(revision.sha, 40)))}`);
				lines.push(`${paint.dim("Changed files")} ${changed.map((path) => oneLine(path, 60)).join(", ") || "—"}`);
				lines.push(paint.muted("Only a clean worktree at the baseline is fast-forwarded; nothing is rebased or merged."));
			}
			if (confirmation.kind === "continue-cycle") {
				const continuation = bag(subject.continuation);
				lines.push(`${paint.dim("Active Target")} ${shortSha(text(continuation.activeTargetSha, 40))} ${paint.dim("·")} ${text(continuation.branchRef)}`);
				lines.push(paint.muted("Closing the cycle releases this candidate from focus; evidence stays immutable."));
			}
			if (confirmation.kind === "abandon-candidate") lines.push(paint.muted("Abandoning records that this attempt produced no evidence; the applied proposal can be verified again."));
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
		`${paint.dim("Reason")} ${clean(oneLine(confirmation.reason, 300))}`,
		...(EPHEMERAL_SUBJECTS.has(confirmation.kind) ? [] : [`${paint.dim("Exact subject")} ${paint.dim(confirmation.subjectHash)}`]),
	];
}
