/**
 * The basket reading, gathered from what the Workbench already holds: the
 * corpus the run measured, the Spec's jobs, the corpus published before it in
 * the same lineage, the critic's receipt for it, and the failure modes the run
 * diagnosed. `readBasket` is the pure reading; this is the one place that finds
 * its inputs, so the run panel and `/traces` cannot drift apart.
 *
 * A reading that cannot be assembled — a corpus the store lost, a Spec that
 * will not load — is absent, never a failed run: the numbers above it stand on
 * their own artifacts.
 */
import { readBasket } from "../application/basket-reading.js";
import { loadCriticReceipt } from "../application/case-critic.js";
import { loadCorpus, type CorpusMetadata } from "../corpus.js";
import type { EvalRunRecord } from "../eval.js";
import type { RunRecord } from "../provenance.js";
import { loadApprovedSpec } from "../spec.js";
import type { WorkbenchInventory } from "./inventory.js";
import type { WorkbenchBasketReading, WorkbenchImprovementBriefProjection } from "./types.js";

/** The development corpus published just before `corpus` under the same approved Spec, if any. */
function previousCorpusOf(inventory: WorkbenchInventory, corpus: CorpusMetadata, approvedSpecId: string | null): CorpusMetadata | null {
	const siblings = inventory.corpora
		.filter((candidate) =>
			candidate.visibility === "development" &&
			candidate.id !== corpus.id &&
			candidate.createdAt < corpus.createdAt &&
			(inventory.developmentLineage.get(candidate.id)?.publication.approvedSpecId ?? null) === approvedSpecId)
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	return siblings[0] ?? null;
}

export function basketReadingOf(
	host: { stateRoot: string; projectId: string },
	inventory: WorkbenchInventory,
	run: EvalRunRecord,
	runs: readonly RunRecord[],
	brief: WorkbenchImprovementBriefProjection,
): WorkbenchBasketReading | null {
	try {
		const corpus = inventory.corpora.find((item) => item.visibility === "development" && item.hash === run.datasetHash);
		if (!corpus) return null;
		const approvedSpecId = inventory.developmentLineage.get(corpus.id)?.publication.approvedSpecId ?? null;
		let jobs: string[] = [];
		if (approvedSpecId) {
			jobs = [...loadApprovedSpec({ stateRoot: host.stateRoot, projectId: host.projectId, specId: approvedSpecId }).snapshot.spec.jobs];
		}
		const tasks = loadCorpus({ stateRoot: host.stateRoot, projectId: host.projectId, corpusId: corpus.id }).tasks;
		const previous = previousCorpusOf(inventory, corpus, approvedSpecId);
		const previousTaskIds = previous
			? loadCorpus({ stateRoot: host.stateRoot, projectId: host.projectId, corpusId: previous.id }).tasks.map((task) => task.id)
			: null;
		return readBasket({
			evalRunId: run.evalRunId,
			repetitions: run.repetitions,
			runs,
			tasks,
			jobs,
			previousTaskIds,
			critic: loadCriticReceipt(host.stateRoot, host.projectId, { hash: corpus.hash }),
			// Every mode the diagnosis named is still failing on this run.
			unresolvedModes: brief.modes.map((mode) => mode.title),
		});
	} catch {
		return null;
	}
}
