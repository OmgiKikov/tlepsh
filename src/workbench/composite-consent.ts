import { execFileSync } from "node:child_process";
import { z } from "zod";
import { hashValue } from "../provenance.js";
import type { CandidateRecord } from "../domain/candidate.js";
import type { BuilderCorpusDraft } from "../application/builder-corpus-draft.js";
import { EvaluatorConfigurationSubjectSchema, type EvaluatorConfigurationSubject } from "../application/configure-evaluators.js";
import type { SpecSnapshot } from "../spec.js";
import type { WorkbenchInventory } from "./inventory.js";
import type { WorkbenchDecisionInput, WorkbenchHumanGate, WorkbenchProposalReview } from "./types.js";
import { WorkbenchStaleDecisionError } from "./errors.js";

export function testingConsent(inventory: WorkbenchInventory, selection: {
	specDraftId: string | null; approvedSpecId: string | null; corpusDraftId: string | null;
}) {
	const spec = inventory.specs.find((item) => item.id === (selection.specDraftId ?? selection.approvedSpecId));
	const corpus = selection.corpusDraftId === null ? null : inventory.corpusDrafts.find((item) => item.id === selection.corpusDraftId);
	if (!spec || corpus === undefined || inventory.integrityBlockers.length > 0) throw new WorkbenchStaleDecisionError("start-testing");
	return {
		specHash: hashValue(spec), corpusHash: corpus ? hashValue(corpus) : null,
		target: inventory.target ? {
			id: inventory.target.manifest.id, sha: inventory.target.gitSha,
			manifestHash: hashValue(inventory.target.manifest),
		} : null,
	};
}

export function shipConsent(repositoryDir: string, candidate: CandidateRecord, proposal: WorkbenchProposalReview | null, version?: string) {
	const git = (...args: string[]): string => execFileSync("git", ["-C", repositoryDir, ...args], { encoding: "utf8" }).trim();
	return {
		branchRef: git("symbolic-ref", "-q", "HEAD"), head: git("rev-parse", "--verify", "HEAD^{commit}"),
		candidateId: candidate.candidateId, candidateHash: hashValue(candidate),
		candidate,
		proposalHash: proposal ? hashValue(proposal) : null, version: version ?? null,
	};
}

/** Only the completed direct decision may advance reviewed facts. */
export function advanceShipConsent(before: ReturnType<typeof shipConsent>, after: ReturnType<typeof shipConsent>, step: string) {
	const built = before.candidate.events.find((event) => event.type === "built");
	const expectedHead = step === "adopt-candidate" && built?.type === "built" ? built.candidate.sha : before.head;
	const { candidate: _beforeRecord, candidateHash: _beforeHash, head: _beforeHead, ...beforeFixed } = before;
	const { candidate: _afterRecord, candidateHash: _afterHash, head: _afterHead, ...afterFixed } = after;
	if (hashValue(beforeFixed) !== hashValue(afterFixed) || after.head !== expectedHead) throw new WorkbenchStaleDecisionError("ship");
	if (step === "review-candidate" || step === "promote-candidate") {
		const { events: beforeEvents, ...beforeIdentity } = before.candidate;
		const { events: afterEvents, ...afterIdentity } = after.candidate;
		const expectedType = step === "review-candidate" ? "reviewed" : "promoted";
		if (hashValue(beforeIdentity) !== hashValue(afterIdentity) || afterEvents.length !== beforeEvents.length + 1 ||
			hashValue(afterEvents.slice(0, -1)) !== hashValue(beforeEvents) || afterEvents.at(-1)?.type !== expectedType) {
			throw new WorkbenchStaleDecisionError("ship");
		}
	} else if (before.candidateHash !== after.candidateHash) throw new WorkbenchStaleDecisionError("ship");
	return after;
}

/** A changed or unreadable reviewed subject never becomes fresh consent for a child. */
export function assertCompositeFresh<T>(kind: "start-testing" | "ship", before: T, read: () => T): void {
	try {
		if (hashValue(before) === hashValue(read())) return;
	} catch { /* The reviewed subject disappearing is stale too. */ }
	throw new WorkbenchStaleDecisionError(kind);
}

const SpecApprovalSubject = z.object({ draftSpecId: z.string(), draftSnapshotHash: z.string() });
const CorpusPublicationSubject = z.object({ draftId: z.string(), draftHash: z.string() });
const CandidateDecisionSubject = z.object({
	candidateHash: z.string(), candidate: z.object({ candidateId: z.string() }),
	recommendation: z.string().optional(), version: z.string().optional(),
	adoption: z.object({ branch: z.object({ ref: z.string() }) }).optional(),
});

export function matchesSpecApproval(subject: unknown, draft: SpecSnapshot): boolean {
	const value = SpecApprovalSubject.safeParse(subject);
	return value.success && value.data.draftSpecId === draft.id && value.data.draftSnapshotHash === hashValue(draft);
}

export function matchesCorpusPublication(subject: unknown, draft: BuilderCorpusDraft): boolean {
	const value = CorpusPublicationSubject.safeParse(subject);
	return value.success && value.data.draftId === draft.id && value.data.draftHash === hashValue(draft);
}

export function matchesEvaluatorConfiguration(subject: unknown, expected: EvaluatorConfigurationSubject): boolean {
	const value = EvaluatorConfigurationSubjectSchema.safeParse(subject);
	return value.success && value.data.subjectHash === expected.subjectHash;
}

const DevelopmentRunSubject = z.object({
	operation: z.literal("run-development-evaluation"), repetitions: z.number(),
	target: z.object({ id: z.string(), gitSha: z.string() }),
	approvedSpec: z.object({ id: z.string(), snapshotHash: z.string() }),
	developmentCorpus: z.object({ id: z.string(), hash: z.string(), taskCount: z.number(), lineageHash: z.string() }),
});

export function matchesPublishedRun(subject: unknown, expected: {
	repetitions: number; target: { id: string; sha: string } | null; approved: SpecSnapshot;
	corpus: { id: string; hash: string; taskCount: number; lineageHash: string } | null;
}): boolean {
	const value = DevelopmentRunSubject.safeParse(subject);
	return value.success && expected.target !== null && expected.corpus !== null &&
		value.data.repetitions === expected.repetitions && value.data.target.id === expected.target.id &&
		value.data.target.gitSha === expected.target.sha && value.data.approvedSpec.id === expected.approved.id &&
		value.data.approvedSpec.snapshotHash === hashValue(expected.approved) &&
		hashValue(value.data.developmentCorpus) === hashValue(expected.corpus);
}

export function matchesCandidateDecision(subject: unknown, reviewed: ReturnType<typeof shipConsent>, options: {
	recommendation?: "promote"; version?: string; adoption?: boolean;
} = {}): boolean {
	const value = CandidateDecisionSubject.safeParse(subject);
	if (!value.success) return false;
	return value.data.candidate.candidateId === reviewed.candidateId && value.data.candidateHash === reviewed.candidateHash &&
		(options.recommendation === undefined || value.data.recommendation === options.recommendation) &&
		(options.version === undefined || value.data.version === options.version) &&
		(!options.adoption || value.data.adoption?.branch.ref === reviewed.branchRef);
}

/** One-use approvals cover only the exact child subjects the host planned. */
export function compositeGate(
	gate: WorkbenchHumanGate, actor: string,
	planned: ReadonlyMap<WorkbenchDecisionInput["kind"], (subject: unknown) => boolean>,
): WorkbenchHumanGate {
	const used = new Set<WorkbenchDecisionInput["kind"]>();
	return {
		async confirm(confirmation, signal) {
			if (confirmation.kind === "workshop-grant" || confirmation.kind === "tool-authoring") return gate.confirm(confirmation, signal);
			const matches = planned.get(confirmation.kind);
			if (matches && !used.has(confirmation.kind)) {
				if (!matches(confirmation.subject)) throw new WorkbenchStaleDecisionError(confirmation.kind);
				used.add(confirmation.kind);
				return { approved: true, actorId: actor };
			}
			return gate.confirm(confirmation, signal);
		},
		selectSealed: (request, signal) => gate.selectSealed(request, signal),
	};
}
