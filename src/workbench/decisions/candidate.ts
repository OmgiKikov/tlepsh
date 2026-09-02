// One family of Workbench decisions, moved out of `AhdeWorkbench.decide()`
// unchanged: the gate, the stale check and the receipts are still the
// workbench's own; these functions only hold the branch bodies.
import { plural as localizedCount, t } from "../../i18n.js";
import { loadDevelopmentCorpusPublicationReceipt } from "../../application/builder-authoring.js";
import { runAppliedBuilderCandidate } from "../../application/builder-candidate.js";
import { SEALED_GATE_POLICY, sealedOutcome, sealedOutcomeLine } from "../../domain/comparison-gate.js";
import { type CheapCheckResult } from "../../application/cheap-check.js";
import { loadBuilderApplyReceipt } from "../../application/builder-proposal.js";
import { listCorpora, loadCorpus, type CorpusMetadata, type CorpusRef } from "../../corpus.js";
import { candidateStatus } from "../../domain/candidate.js";
import { hashValue } from "../../provenance.js";
import { recordCandidateAbandonment } from "../candidate-abandonment.js";
import { WorkbenchDecisionDeclinedError, WorkbenchStaleDecisionError } from "../errors.js";
import { candidateSummary, requireCandidate, requireDevelopmentCorpus, requireProposal, resolveOne } from "../resolution.js";
import { abortIfRequested, actorId, exactSame } from "../workbench.js";
import { CandidateExperimentError } from "../../application/candidate-experiment.js";
import type { DecisionContext, DecisionHost, DecisionInputOf } from "./shared.js";
import type { WorkbenchDecisionResult } from "../types.js";

export async function decideVerifyCandidate(
	host: DecisionHost,
	input: DecisionInputOf<"verify-candidate">,
	ctx: DecisionContext,
): Promise<WorkbenchDecisionResult> {
	const { inventory, stage, gate, options } = ctx;
	const interrupted = inventory.candidates.find((candidate) =>
		["proposed", "built", "validated"].includes(candidateStatus(candidate)) &&
		!inventory.abandonedCandidates.has(candidate.candidateId)
	);
	if (interrupted) {
		throw new Error(
			`candidate ${interrupted.candidateId} stopped at ${candidateStatus(interrupted)}; ` +
			"review and explicitly abandon or recover it before starting another verification",
		);
	}
	const proposal = requireProposal(inventory, "applied", input.builderRunId);
	// A construction change can be applied before the first basket or the
	// exam exists, and this is where that is found out. Each refusal names
	// the request that supplies what is missing: the exit is forward, never
	// a retreat — nothing here can be discarded or abandoned, only completed.
	const verifiedSpecId = proposal.record.request.approvedSpec?.specId;
	if (verifiedSpecId) {
		try {
			requireDevelopmentCorpus(inventory, undefined, verifiedSpecId);
		} catch (error) {
			throw new Error(
				`${error instanceof Error ? error.message : String(error)}. The candidate is measured on the published ` +
				"basket of its Spec: write the cases (corpus-draft) and publish them (publish-corpus — legal at this stage), " +
				"or import a dataset; then verify again.",
			);
		}
	}
	let sealed: CorpusMetadata[];
	try {
		sealed = listCorpora({ stateRoot: host.stateRoot, projectId: host.projectId }).filter((corpus) => corpus.visibility === "sealed");
	} catch {
		throw new Error("evaluator-owned sealed holdout inventory is unavailable; identities remain hidden");
	}
	if (sealed.length === 0) {
		throw new Error(
			"Candidate verification requires an evaluator-owned sealed holdout corpus. Get one first: request generate-holdout " +
			"(the Target's judge writes it from the Spec; the operator's /holdout does the same) or import a sealed JSONL; then verify again.",
		);
	}
	const choice = await gate.selectSealed({ title: "Select evaluator-only sealed holdout", options: sealed.map((corpus, index) => ({ label: `Holdout ${index + 1} · ${corpus.name}`, taskCount: corpus.taskCount })) }, options.signal);
	abortIfRequested(options.signal);
	if (!choice.approved) throw new WorkbenchDecisionDeclinedError(input.kind);
	if (choice.selectedIndex === undefined || !sealed[choice.selectedIndex]) throw new Error("human gate returned an invalid sealed holdout selection");
	const selected = sealed[choice.selectedIndex]!;
	if (selected.taskCount < SEALED_GATE_POLICY.minTasks) {
		throw new Error(
			`The selected sealed holdout has ${selected.taskCount} task${selected.taskCount === 1 ? "" : "s"}; ` +
			`a sealed verdict needs at least ${SEALED_GATE_POLICY.minTasks}. Add holdout cases before verifying.`,
		);
	}
	if (input.repetitions < SEALED_GATE_POLICY.minRepetitions) {
		throw new Error(`Candidate verification needs at least ${SEALED_GATE_POLICY.minRepetitions} repetitions for a sealed verdict.`);
	}
	const build = () => {
		const current = host.decisionInventory(input.kind);
		const partial = current.candidates.find((candidate) =>
			["proposed", "built", "validated"].includes(candidateStatus(candidate)) &&
			!current.abandonedCandidates.has(candidate.candidateId)
		);
		if (partial) throw new WorkbenchStaleDecisionError(input.kind);
		const currentProposal = requireProposal(current, "applied", proposal.record.runId);
		const builderRun = currentProposal.record;
		const applyReceipt = loadBuilderApplyReceipt(host.runsRoot, proposal.record.runId);
		if (builderRun.request.approvedSpec?.projectId !== host.projectId) throw new Error("Builder proposal is not bound to this project approved Spec");
		let sealedLoaded: ReturnType<typeof loadCorpus>;
		try {
			sealedLoaded = loadCorpus({ stateRoot: host.stateRoot, projectId: host.projectId, corpusId: selected.id });
		} catch {
			throw new Error("selected evaluator-owned holdout is unavailable or changed; identity remains hidden");
		}
		if (sealedLoaded.metadata.visibility !== "sealed" || sealedLoaded.metadata.hash !== selected.hash) throw new Error("sealed holdout changed");
		// The development arm is the published development corpus of the Spec
		// this proposal was written against — the operator's own cases, resolved
		// exactly the way `run-eval` resolves them. It is never the manifest
		// dataset: a construction proposal carries no attestation at all, and
		// falling back to `evalSuite.dataset` measured a template file nobody
		// wrote and called the result the development verdict.
		const approvedSpecId = builderRun.request.approvedSpec.specId;
		const currentCorpus = requireDevelopmentCorpus(current, undefined, approvedSpecId);
		const receipt = loadDevelopmentCorpusPublicationReceipt(host.stateRoot, host.projectId, currentCorpus.id);
		const lineage = current.developmentLineage.get(currentCorpus.id);
		const loaded = loadCorpus({ stateRoot: host.stateRoot, projectId: host.projectId, corpusId: currentCorpus.id });
		if (
			!lineage ||
			lineage.publication.approvedSpecId !== approvedSpecId ||
			loaded.metadata.visibility !== "development" ||
			loaded.metadata.hash !== receipt.corpus.hash
		) throw new Error("development corpus does not match its reviewed Spec lineage");
		// An improvement proposal names the basket it was measured on. It has to
		// be that same one, or before and after would compare two different exams.
		const attested = builderRun.request.sourceAttestation?.developmentCorpus;
		if (attested && (attested.id !== loaded.metadata.id || attested.hash !== loaded.metadata.hash)) {
			throw new Error(
				"the Builder measured a development corpus that is not the published one of this Spec; " +
				"publish the corpus it used, or author against the published one",
			);
		}
		const development = { id: loaded.metadata.id, hash: loaded.metadata.hash, taskCount: loaded.metadata.taskCount };
		const developmentCorpus: CorpusRef = { stateRoot: host.stateRoot, projectId: host.projectId, corpusId: loaded.metadata.id };
		return {
			subject: { operation: "verify-applied-candidate", builderRunId: builderRun.runId, builderRunHash: hashValue(builderRun), applyReceiptHash: hashValue(applyReceipt), proposalHash: builderRun.artifacts.proposal?.sha256 ?? null, baseTargetSha: applyReceipt.baseTargetSha, candidateSha: applyReceipt.candidateSha, approvedSpec: builderRun.request.approvedSpec, developmentCorpus: development, sealedHoldout: { id: selected.id, hash: selected.hash, taskCount: selected.taskCount }, repetitions: input.repetitions, screen: builderRun.request.source?.evalRunId ?? null, force: input.force === true },
			approvedSpecId: builderRun.request.approvedSpec.specId,
			sourceEvalRunId: builderRun.request.source?.evalRunId ?? null,
			// The receipt of this exact candidate is the authorization: it says
			// what the human who read this diff was told the check would cost.
			// A candidate applied outside that dialog carries none.
			authorized: applyReceipt.verificationAuthorization ?? null,
			developmentCorpus,
			sealedCorpus: { stateRoot: host.stateRoot, projectId: host.projectId, corpusId: selected.id } satisfies CorpusRef,
		};
	};
	const before = build();
	// Two arms over the development basket and the sealed holdout.
	const developmentTasks = before.subject.developmentCorpus.taskCount;
	const executions = 2 * (developmentTasks + selected.taskCount) * input.repetitions;
	const actor = await host.confirm(input, gate, t("confirm.title.verify-candidate"), before.subject, options.signal, {
		question: before.sourceEvalRunId
			? t("confirm.verify-candidate.screened", { runs: localizedCount(executions + developmentTasks, "execution") })
			: t("confirm.verify-candidate", { runs: localizedCount(executions, "execution") }),
		estimate: host.runEstimate(executions + (before.sourceEvalRunId ? developmentTasks : 0), inventory.target),
		authorized: before.authorized,
	});
	if (choice.actorId && actorId(choice.actorId) !== actor) throw new Error("sealed selection and confirmation came from different human actors");
	const after = build();
	if (!exactSame(before.subject, after.subject)) throw new WorkbenchStaleDecisionError(input.kind);

	// The cheap check first. It runs the candidate on the cases that already
	// failed, once, candidate arm only — a screen, never evidence: it enters
	// no gate and can never reach promotion. A flat screen stops the spend
	// unless the operator explicitly forced it; a screen whose own
	// infrastructure errors blew the budget is inconclusive and stops
	// nothing (invariant 9).
	let screen: CheapCheckResult | null = null;
	if (after.sourceEvalRunId) {
		try {
			screen = await host.dependencies.runCheapCheck({
				repositoryDir: host.projectDir,
				runsRoot: host.runsRoot,
				candidateRef: after.subject.candidateSha,
				baselineRef: after.subject.baseTargetSha,
				sourceEvalRunId: after.sourceEvalRunId,
				developmentCorpus: after.developmentCorpus,
				...(options.signal ? { signal: options.signal } : {}),
				...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
				now: host.dependencies.now,
			});
		} catch (error) {
			// A screen that cannot run is not a verdict. Say so and measure.
			console.error("AHDE host-only cheap check failure:", error);
			screen = null;
		}
	}
	if (screen && screen.verdict === "flat" && screen.withinErrorBudget && input.force !== true) {
		const projection = host.screenProjection(screen);
		return {
			kind: input.kind,
			message:
				`Cheap check found nothing: ${screen.tasks.length} previously failing case` +
				`${screen.tasks.length === 1 ? "" : "s"} re-run once on the candidate, ` +
				`${screen.improved} improved, ${screen.unchanged} unchanged, ${screen.regressed} regressed. ` +
				`The ${executions}-execution verification was not spent. ` +
				"Author another change, or verify anyway with force.",
			result: {
				outcome: "stopped-by-screen",
				builderRunId: after.subject.builderRunId,
				candidateSha: after.subject.candidateSha,
				screen: projection,
				spared: { executions },
			},
			view: await host.viewOf(host.inventory()),
		};
	}

	let result: Awaited<ReturnType<typeof runAppliedBuilderCandidate>>;
	try {
		result = await host.dependencies.runAppliedCandidate({
			repositoryDir: host.projectDir,
			runsRoot: host.runsRoot,
			builderRunId: proposal.record.runId,
			expectedBuilderRunHash: after.subject.builderRunHash,
			expectedApplyReceiptHash: after.subject.applyReceiptHash,
			projectId: host.projectId,
			approvedSpec: { stateRoot: host.stateRoot, specId: after.approvedSpecId },
			repetitions: input.repetitions,
			developmentCorpus: after.developmentCorpus,
			sealedCorpus: after.sealedCorpus,
			actorId: actor,
			...(options.onRunEvent ? { onRunEvent: options.onRunEvent } : {}),
			...(options.signal ? { signal: options.signal } : {}),
		});
	} catch (error) {
		// Exact evaluator diagnostics remain host-only because thrown messages can
		// otherwise become Builder model context through a failed tool result.
		console.error("AHDE host-only candidate verification failure:", error);
		// A stop in the development arms names only development evidence, and
		// the operator needs the reason: a run that errored is an infrastructure
		// failure, not a verdict, and the way out is to abandon and verify again.
		if (error instanceof CandidateExperimentError && error.phase === "development") {
			throw new Error(
				`the check stopped before the exam: ${error.reason.replace(/^candidate experiment stopped at validated: /, "")}. ` +
				"Nothing was decided — abandon the interrupted attempt (/discard) and verify again.",
			);
		}
		throw new Error("candidate verification failed during the sealed exam; sealed identities and contents remain hidden. Abandon the interrupted attempt (/discard) and verify again.");
	}
	const settled = host.select("candidate", result.record.candidateId);
	const sealedVerdict = result.sealedHoldout?.compare.gate.verdict ?? null;
	// `pass` alone is what the model paraphrases as "the exam passed", and half
	// the time that is false: the interval spanned zero and the exam convicted
	// nobody. The result hands over the exact phrase, and what it means.
	const sealedDecided = {
		verdict: sealedVerdict ?? "",
		confidence95: result.sealedHoldout?.compare.summary.confidence95 ?? null,
	};
	const outcomeLine = sealedOutcomeLine(sealedDecided);
	return {
		kind: input.kind,
		message: sealedVerdict === "pass"
			? `Candidate verification completed: development compared, and the sealed exam is “${outcomeLine}”. ${
				sealedOutcome(sealedDecided) === "improved"
					? "Say the exam proved an improvement — never only that it passed."
					: "The exam proved no regression and no improvement: say both halves, and never call it an improvement."
			}`
			: sealedVerdict === null
				? "Candidate verification completed on development evidence; no sealed holdout ran."
				: `Candidate verification completed; the sealed guardrail verdict is ${sealedVerdict}, so this candidate cannot be promoted.`,
		result: {
			outcome: "verified",
			candidate: candidateSummary(result.record),
			development: { verdict: result.compare.gate.verdict, delta: result.compare.summary.delta, confidence95: result.compare.summary.confidence95 },
			sealedHoldout: { executed: result.sealedHoldout !== null, gatePassed: sealedVerdict === "pass", verdict: sealedVerdict },
			screen: screen ? host.screenProjection(screen) : null,
		},
		view: await host.viewOf(settled),
	};
}

export async function decideAbandonCandidate(
	host: DecisionHost,
	input: DecisionInputOf<"abandon-candidate">,
	ctx: DecisionContext,
): Promise<WorkbenchDecisionResult> {
	const { inventory, gate, options } = ctx;
	const candidates = inventory.candidates.filter((candidate) =>
		candidate.projectId === host.projectId &&
		["proposed", "built", "validated"].includes(candidateStatus(candidate)) &&
		!inventory.abandonedCandidates.has(candidate.candidateId)
	);
	const candidate = resolveOne({
		items: candidates,
		explicitId: input.candidateId,
		focusId: inventory.validFocus.candidate?.id,
		id: (item) => item.candidateId,
		label: "interrupted candidate",
	});
	const status = candidateStatus(candidate);
	if (status !== "proposed" && status !== "built" && status !== "validated") {
		throw new Error("only an interrupted candidate checkpoint can be abandoned");
	}
	const before = {
		operation: "abandon-interrupted-candidate",
		candidateHash: hashValue(candidate),
		candidate: candidateSummary(candidate),
	};
	const actor = await host.confirm(input, gate, t("confirm.title.abandon-candidate"), before, options.signal, {
		question: t("confirm.abandon-candidate"),
	});
	const current = host.decisionInventory(input.kind);
	if (current.abandonedCandidates.has(candidate.candidateId)) throw new WorkbenchStaleDecisionError(input.kind);
	const reloaded = requireCandidate(current, [status], candidate.candidateId);
	if (hashValue(reloaded) !== hashValue(candidate)) throw new WorkbenchStaleDecisionError(input.kind);
	const receipt = recordCandidateAbandonment({
		stateRoot: host.stateRoot,
		projectId: host.projectId,
		candidate: reloaded,
		interruptedStatus: status,
		actor: { kind: "human", id: actor },
		reason: input.reason,
		now: host.dependencies.now,
	});
	const settled = candidate.origin.kind === "applied-builder"
		? host.select("proposal", candidate.origin.builderRunId)
		: host.inventory();
	return {
		kind: input.kind,
		message: "Interrupted candidate attempt abandoned durably; the exact applied proposal can be retried.",
		result: { candidateId: candidate.candidateId, interruptedStatus: status, receiptHash: receipt.receiptHash },
		view: await host.viewOf(settled),
	};
}
