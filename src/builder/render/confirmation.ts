import type { WorkbenchCandidateSummary, WorkbenchConfirmation } from "../../workbench/types.js";
import { diffStats, renderUnifiedDiff } from "./diff.js";
import { bullets, clean, numbered, oneLine, pluralize, shortHash, shortSha, wrap } from "./format.js";
import type { Paint } from "./paint.js";
import { renderCandidate } from "./view.js";

const MAX_CONFIRM_DIFF_LINES = 200;

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
			const lines = isCandidateSummary(subject.candidate) ? renderCandidate(subject.candidate, paint) : describe(subject.candidate, paint);
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
