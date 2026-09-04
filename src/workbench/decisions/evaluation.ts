// One family of Workbench decisions, moved out of `AhdeWorkbench.decide()`
// unchanged: the gate, the stale check and the receipts are still the
// workbench's own; these functions only hold the branch bodies.
import { plural as localizedCount, t } from "../../i18n.js";
import { loadDevelopmentCorpusPublicationReceipt } from "../../application/builder-authoring.js";
import { resolveScoredCasesForEval, targetWithDevelopmentCorpus } from "../../application/corpus-target.js";
import { compileRegradeDiff, estimateRegradeJudgeSpend, planRegradeGraders, type RegradeDiff } from "../../application/regrade-decision.js";
import { loadCorpus, type CorpusRef } from "../../corpus.js";
import { loadVerifiedEvalRun, type EvalRunRecord } from "../../eval.js";
import {
	judgeEvidenceCalibration,
	recordJudgeCalibrationOffer,
	JUDGE_CALIBRATION_PROMPT_LABELS,
} from "../../application/judge-labels.js";
import { judgeAbstentions } from "../../application/run-explanation.js";
import { loadTarget, type ResolvedTarget } from "../../manifest.js";
import { hashValue } from "../../provenance.js";
import { WorkbenchStaleDecisionError } from "../errors.js";
import { diagnosisSummary, requireApprovedSpec, evaluationProjection, requireCorpusDraft, requireDevelopmentCorpus } from "../resolution.js";
import { calibrationProjection } from "../calibration.js";
import { runResultLine } from "../../application/measurement-line.js";
import { abortIfRequested, actorId, exactSame, boundedEvidenceLink, conversationalImprovementBrief } from "../workbench.js";
import type { DecisionContext, DecisionHost, DecisionInputOf } from "./shared.js";
import type { WorkbenchDecisionResult, WorkbenchRunEvalResult, WorkbenchTracesDetail } from "../types.js";

/**
 * What one eval says about the judge that graded it: how far that judge has
 * been checked against a human, and how often it declined to decide.
 *
 * Both readings are about the instrument rather than the agent, and both
 * swallow their own errors: a missing or unreadable label store degrades to
 * silence, never to a blocked run or a claim nobody can support.
 */
export function judgeAgreementOfEval(
	host: Pick<DecisionHost, "runsRoot" | "stateRoot" | "projectId">,
	evalRunId: string,
): Pick<WorkbenchTracesDetail, "judgeAgreement" | "judgeAbstained"> {
	const calibration = evidenceCalibration(host, evalRunId);
	// No judge grader graded this run: there is no instrument to talk about, and
	// a screen that said "not calibrated" here would be making that up.
	if (!calibration || calibration.specHashes.length === 0) return {};
	const stats = calibration.stats;
	let abstained = 0;
	try {
		abstained = judgeAbstentions(loadVerifiedEvalRun(host.runsRoot, evalRunId).runs);
	} catch {
		abstained = 0;
	}
	return {
		judgeAgreement: stats && stats.n > 0
			? { agreement: stats.agreement, kappa: stats.kappa, labels: stats.n }
			: null,
		...(abstained > 0 ? { judgeAbstained: abstained } : {}),
	};
}

function evidenceCalibration(
	host: Pick<DecisionHost, "runsRoot" | "stateRoot" | "projectId">,
	evalRunId: string,
): ReturnType<typeof judgeEvidenceCalibration> | null {
	try {
		return judgeEvidenceCalibration({
			runsRoot: host.runsRoot,
			stateRoot: host.stateRoot,
			projectId: host.projectId,
			evalRunIds: [evalRunId],
			// A screen shows every label the operator wrote, including the ones the
			// promotion gate refuses; only `requireCalibration` reads the strict set.
			includeLegacyLabels: true,
		});
	} catch {
		return null;
	}
}

/**
 * The same reading, plus the one-time offer to check this judge by hand. Only
 * a run makes the offer: reading `/traces` twice is not two invitations, and
 * the marker under the state root is what makes "once" survive a restart.
 */
export function judgeReadingOfEval(
	host: Pick<DecisionHost, "runsRoot" | "stateRoot" | "projectId">,
	evalRunId: string,
): Pick<WorkbenchRunEvalResult, "judgeAgreement" | "judgeAbstained" | "judgeCalibration"> {
	const reading = judgeAgreementOfEval(host, evalRunId);
	if (reading.judgeAgreement === undefined) return reading;
	const labelled = reading.judgeAgreement?.labels ?? 0;
	let offered = false;
	if (labelled < JUDGE_CALIBRATION_PROMPT_LABELS) {
		try {
			offered = recordJudgeCalibrationOffer(host.stateRoot, host.projectId, evalRunId);
		} catch {
			// An unwritable label directory costs the operator an invitation, never
			// the run they just paid for.
			offered = false;
		}
	}
	return { ...reading, judgeCalibration: { labelled, offered } };
}

export async function decideRunEval(
	host: DecisionHost,
	input: DecisionInputOf<"run-eval">,
	ctx: DecisionContext,
): Promise<WorkbenchDecisionResult> {
	const { inventory, gate, options } = ctx;
	if (!inventory.target) throw new Error("Target is not ready");
	const approved = requireApprovedSpec(inventory);
	const corpus = requireDevelopmentCorpus(inventory, input.developmentCorpusId, approved.id);
	const build = (): { target: ResolvedTarget; subject: Record<string, unknown> } => {
		const current = host.decisionInventory(input.kind);
		const currentApproved = requireApprovedSpec(current, approved.id);
		const currentCorpus = requireDevelopmentCorpus(current, corpus.id, currentApproved.id);
		let target = loadTarget(host.projectDir);
		const receipt = loadDevelopmentCorpusPublicationReceipt(host.stateRoot, host.projectId, currentCorpus.id);
		const lineage = current.developmentLineage.get(currentCorpus.id);
		const loaded = loadCorpus({ stateRoot: host.stateRoot, projectId: host.projectId, corpusId: currentCorpus.id });
		if (
			!lineage ||
			lineage.publication.approvedSpecId !== currentApproved.id ||
			loaded.metadata.visibility !== "development" ||
			loaded.metadata.hash !== receipt.corpus.hash
		) throw new Error("development corpus does not match its reviewed Spec lineage");
		target = targetWithDevelopmentCorpus(target, loaded);
		return { target, subject: { operation: "run-development-evaluation", projectId: host.projectId, approvedSpec: { id: currentApproved.id, snapshotHash: hashValue(currentApproved) }, target: { id: target.manifest.id, gitSha: target.gitSha, toolsetHash: target.toolsetHash }, dataset: target.manifest.evalSuite.dataset, datasetHash: target.datasetHash, suiteHash: target.suiteHash, taskCount: target.tasks.length, repetitions: input.repetitions, developmentCorpus: { id: loaded.metadata.id, hash: loaded.metadata.hash, taskCount: loaded.metadata.taskCount, lineageHash: lineage.publication.linkHash } } };
	};
	const before = build();
	await host.confirm(input, gate, t("confirm.title.run-eval"), before.subject, options.signal, {
		question: t("confirm.run-eval", { runs: localizedCount(Number(before.subject.taskCount) * input.repetitions, "execution") }),
		estimate: host.runEstimate(Number(before.subject.taskCount) * input.repetitions, inventory.target),
	});
	const after = build();
	if (!exactSame(before.subject, after.subject)) throw new WorkbenchStaleDecisionError(input.kind);
	const record = await host.dependencies.runSuite(after.target, {
		runsRoot: host.runsRoot,
		label: "solo",
		repetitions: input.repetitions,
		...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
		...(options.signal ? { signal: options.signal } : {}),
	});
	abortIfRequested(options.signal);
	const diagnosis = host.dependencies.diagnoseEval(host.runsRoot, record.evalRunId);
	const improvementBrief = host.dependencies.compileImprovementBrief(host.runsRoot, diagnosis);
	const link = boundedEvidenceLink(await host.dependencies.evidenceLink(record));
	const settled = host.select("eval-run", record.evalRunId);
	const projection = evaluationProjection(record, inventory.corpora, loadVerifiedEvalRun(host.runsRoot, record.evalRunId).runs);
	const brief = conversationalImprovementBrief(improvementBrief);
	// The one sentence about this run, composed once by the host, so the panel,
	// the status bar and the sentence the Builder quotes are the same string.
	const headline = runResultLine({
		pass: projection.summary.pass,
		total: projection.summary.total,
		failureModes: brief.summary.failureModeCount,
	});
	// Read after the run and before the view: the offer marker this may write is
	// exactly what the view's `next` block then reports as a standing offer.
	const judge = judgeReadingOfEval(host, record.evalRunId);
	return { kind: input.kind, message: improvementBrief.headline, result: { headline, evaluation: projection, diagnosis: diagnosisSummary(diagnosis), improvementBrief: brief, evidence: link ? { available: true, ...link } : { available: false }, ...judge }, view: await host.viewOf(settled) };
}

export async function decideCalibrate(
	host: DecisionHost,
	input: DecisionInputOf<"calibrate">,
	ctx: DecisionContext,
): Promise<WorkbenchDecisionResult> {
	const { inventory, gate, options } = ctx;
	if (!inventory.target) throw new Error("Target is not ready");
	const approved = requireApprovedSpec(inventory);
	const corpus = requireDevelopmentCorpus(inventory, undefined, approved.id);
	const build = (): {
		subject: Record<string, unknown>;
		targetGitSha: string;
		approvedSpecId: string;
		developmentCorpus: CorpusRef;
	} => {
		const current = host.decisionInventory(input.kind);
		const currentApproved = requireApprovedSpec(current, approved.id);
		const currentCorpus = requireDevelopmentCorpus(current, corpus.id, currentApproved.id);
		const target = loadTarget(host.projectDir);
		const receipt = loadDevelopmentCorpusPublicationReceipt(host.stateRoot, host.projectId, currentCorpus.id);
		const lineage = current.developmentLineage.get(currentCorpus.id);
		const loaded = loadCorpus({ stateRoot: host.stateRoot, projectId: host.projectId, corpusId: currentCorpus.id });
		if (
			!lineage ||
			lineage.publication.approvedSpecId !== currentApproved.id ||
			loaded.metadata.visibility !== "development" ||
			loaded.metadata.hash !== receipt.corpus.hash
		) throw new Error("development corpus does not match its reviewed Spec lineage");
		return {
			subject: {
				operation: "calibrate-noise",
				target: { id: target.manifest.id, gitSha: target.gitSha },
				developmentCorpus: {
					id: loaded.metadata.id,
					hash: loaded.metadata.hash,
					taskCount: loaded.metadata.taskCount,
				},
				repetitions: input.repetitions,
				executions: 2 * loaded.metadata.taskCount * input.repetitions,
			},
			targetGitSha: target.gitSha,
			approvedSpecId: currentApproved.id,
			developmentCorpus: { stateRoot: host.stateRoot, projectId: host.projectId, corpusId: currentCorpus.id },
		};
	};
	const before = build();
	const actor = await host.confirm(input, gate, t("confirm.title.calibrate"), before.subject, options.signal, {
		question: t("confirm.calibrate", { runs: localizedCount(Number(before.subject.executions), "execution") }),
		estimate: host.runEstimate(Number(before.subject.executions), inventory.target),
	});
	const after = build();
	if (!exactSame(before.subject, after.subject)) throw new WorkbenchStaleDecisionError(input.kind);
	// Both arms are the same exact revision: the experiment measures the
	// harness against itself and can never become promotion evidence.
	const result = await host.dependencies.runCalibration({
		repositoryDir: host.projectDir,
		runsRoot: host.runsRoot,
		baselineRef: after.targetGitSha,
		candidateRef: after.targetGitSha,
		mode: "aa-calibration",
		repetitions: input.repetitions,
		projectId: host.projectId,
		specId: after.approvedSpecId,
		origin: { kind: "manual", reason: "A/A calibration" },
		...(after.developmentCorpus ? { developmentCorpus: after.developmentCorpus } : {}),
		actorId: actor,
		...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
		...(options.signal ? { signal: options.signal } : {}),
	});
	abortIfRequested(options.signal);
	const calibration = calibrationProjection(result.record);
	if (!calibration) throw new Error("calibration produced no development verdict; nothing was measured");
	return {
		kind: input.kind,
		message: `Noise measured on this revision: A/A ${calibration.verdict}; ` +
			`${calibration.recommendedRepetitions} repetition${calibration.recommendedRepetitions === 1 ? "" : "s"} recommended.`,
		result: { candidateId: result.record.candidateId, calibration },
		view: await host.view(),
	};
}

export async function decideRegrade(
	host: DecisionHost,
	input: DecisionInputOf<"regrade">,
	ctx: DecisionContext,
): Promise<WorkbenchDecisionResult> {
	const { inventory, stage, gate, options } = ctx;
	if (!inventory.target) throw new Error("Target is not ready");
	const approved = requireApprovedSpec(inventory);
	// One or two, and the second one is never optional where it exists: a
	// candidate's arms are re-scored as a pair or the number means nothing.
	const sources = host.regradeSources(inventory, stage, input.evalRunId);
	const paired = sources.length > 1;
	const draft = input.graders === "draft"
		? requireCorpusDraft(inventory, undefined, approved.id, true)
		: null;
	const build = (): {
		plan: ReturnType<typeof planRegradeGraders>;
		sources: EvalRunRecord[];
		subject: Record<string, unknown>;
	} => {
		const current = host.decisionInventory(input.kind);
		const currentApproved = requireApprovedSpec(current, approved.id);
		const currentSources = sources.map((source) => host.regradeSource(current, source.evalRunId));
		const currentDraft = draft ? requireCorpusDraft(current, draft.id, currentApproved.id, true) : null;
		const primary = currentSources[0]!;
		// Two arms that answered different case sets were never a comparison,
		// so one revised rubric cannot be planned for both of them.
		for (const source of currentSources) {
			if (source.dataset !== primary.dataset || source.datasetHash !== primary.datasetHash) {
				throw new Error(
					`eval runs ${primary.evalRunId} and ${source.evalRunId} scored different case sets; ` +
					"one re-score covers one set of questions",
				);
			}
		}
		// The exact cases the recorded traces answered, wherever they live:
		// the manifest dataset, or the published corpus that produced them.
		const scored = resolveScoredCasesForEval({
			target: loadTarget(host.projectDir),
			evalRun: primary,
			stateRoot: host.stateRoot,
			projectId: host.projectId,
		}).target;
		const plan = planRegradeGraders({
			scored,
			revised: currentDraft ? currentDraft.tasks : null,
			sourceJudge: primary.provenance.judge,
		});
		return {
			plan,
			sources: currentSources,
			subject: {
				operation: "regrade",
				target: { id: scored.manifest.id, gitSha: scored.gitSha },
				sources: currentSources.map((source) => ({
					evalRunId: source.evalRunId,
					datasetHash: source.datasetHash,
					suiteHash: source.suiteHash,
					runs: source.runIds.length,
				})),
				graders: input.graders,
				...(currentDraft ? { draft: { id: currentDraft.id, hash: hashValue(currentDraft) } } : {}),
				changedGraders: plan.changed.length,
				suiteHash: plan.target.suiteHash,
				// Said in the subject, not only in the panel: the one number
				// that makes this decision cheap is that it buys no Target time.
				targetExecutions: 0,
			},
		};
	};
	const before = build();
	const gradings = before.sources.reduce((total, source) => total + source.runIds.length, 0);
	await host.confirm(input, gate, t("confirm.title.regrade"), before.subject, options.signal, {
		question: t("confirm.regrade", { answers: localizedCount(gradings, "recorded answer") }),
		// A regrade's unit of work is a grading, never a Target execution.
		// The guard prices the judge, which is the only model it pays.
		estimate: estimateRegradeJudgeSpend({
			runsRoot: host.runsRoot,
			targetId: inventory.target.manifest.id,
			gradings,
		}),
	});
	const after = build();
	if (!exactSame(before.subject, after.subject)) throw new WorkbenchStaleDecisionError(input.kind);
	const diffs: RegradeDiff[] = [];
	for (const source of after.sources) {
		const result = await host.dependencies.regradeEvalRun({
			runsRoot: host.runsRoot,
			evalRunId: source.evalRunId,
			target: after.plan.target,
			...(options.signal ? { signal: options.signal } : {}),
		});
		abortIfRequested(options.signal);
		diffs.push(compileRegradeDiff({
			runsRoot: host.runsRoot,
			result,
			graders: input.graders,
			changed: after.plan.changed,
		}));
	}
	// `sources` is in comparison order, so the last diff is the arm whose
	// verdict the operator is arguing with and the first is what it is
	// measured against.
	const baselineDiff = paired ? diffs[0]! : null;
	const diff = diffs[diffs.length - 1]!;
	const rate = (value: number): string => `${Math.round(value * 100)}%`;
	return {
		kind: input.kind,
		message: baselineDiff
			? `Re-scored ${localizedCount(gradings, "recorded answer")} across both development arms ` +
				`with the revised graders: development ${rate(baselineDiff.passRateBefore)} → ${rate(diff.passRateBefore)} ` +
				`became ${rate(baselineDiff.passRateAfter)} → ${rate(diff.passRateAfter)}. ` +
				`The Target was not called; only the judge was paid. ${t("regrade.both-arms")} ` +
				(input.evalRunId ? `${t("regrade.named-one-arm")} ` : "") +
				"This is a re-score, not a new baseline."
			: `Re-scored ${localizedCount(diff.total, "recorded answer")} with the revised graders: ` +
				`${diff.passBefore}/${diff.total} → ${diff.passAfter}/${diff.total}. ` +
				"The Target was not called; only the judge was paid. This is a re-score, not a new baseline.",
		result: baselineDiff ? { ...diff, pairedBaseline: baselineDiff } : diff,
		view: await host.view(),
	};
}
