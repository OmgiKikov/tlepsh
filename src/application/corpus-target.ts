import {
	listCorpora,
	loadCorpus,
	type CorpusVisibility,
	type LoadedCorpus,
} from "../corpus.js";
import type { EvalRunRecord } from "../eval.js";
import type { GraderSpec, ResolvedTarget } from "../manifest.js";
import { hashValue } from "../provenance.js";

function cloneGrader(grader: GraderSpec): GraderSpec {
	return { ...grader };
}

export function corpusDatasetLabel(visibility: CorpusVisibility, corpusId: string): string {
	return `${visibility}-${corpusId}`;
}

export interface EvalSurfaceIdentity {
	dataset: string;
	datasetHash: string;
	suiteHash: string;
}

export function targetEvalSurface(target: ResolvedTarget): EvalSurfaceIdentity {
	return {
		dataset: target.manifest.evalSuite.dataset.replace(/\.jsonl$/, "").split("/").pop() ?? "dataset",
		datasetHash: target.datasetHash,
		suiteHash: target.suiteHash,
	};
}

export function evalSurfaceMatches(
	target: ResolvedTarget,
	evidence: EvalSurfaceIdentity,
): boolean {
	const actual = targetEvalSurface(target);
	return (
		actual.dataset === evidence.dataset &&
		actual.datasetHash === evidence.datasetHash &&
		actual.suiteHash === evidence.suiteHash
	);
}

export function assertEvalSurfaceMatches(
	target: ResolvedTarget,
	evidence: EvalSurfaceIdentity,
	label: string,
): void {
	if (evalSurfaceMatches(target, evidence)) return;
	const actual = targetEvalSurface(target);
	throw new Error(
		`${label} does not match the exact evaluation surface: ` +
			`expected ${evidence.dataset}/${evidence.datasetHash}/${evidence.suiteHash}, ` +
			`got ${actual.dataset}/${actual.datasetHash}/${actual.suiteHash}`,
	);
}

/** Replace only the resolved evaluation surface; corpus content remains in memory. */
function targetWithCorpus(
	target: ResolvedTarget,
	corpus: LoadedCorpus,
	visibility: CorpusVisibility,
): ResolvedTarget {
	if (corpus.metadata.visibility !== visibility) {
		throw new Error(
			`${visibility} evaluation requires a ${visibility} corpus, got ${corpus.metadata.visibility} (${corpus.metadata.id})`,
		);
	}

	const tasks = corpus.tasks.map((task) => {
		const graders = task.graders.map(cloneGrader);
		for (const grader of graders) {
			if (grader.type !== "output_matches") continue;
			try {
				new RegExp(grader.pattern);
			} catch (error) {
				throw new Error(
					`${visibility} corpus ${corpus.metadata.id} task ${task.id} has an invalid output_matches regex: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		return {
			id: task.id,
			input: task.input,
			graders,
			effectiveGraders: graders.map(cloneGrader),
		};
	});

	if (
		tasks.some((task) => task.effectiveGraders.some((grader) => grader.type === "judge")) &&
		!target.manifest.evalSuite.judge
	) {
		throw new Error(`${visibility} corpus ${corpus.metadata.id} uses judge graders but the target has no judge model`);
	}

	return {
		...target,
		manifest: {
			...target.manifest,
			evalSuite: {
				...target.manifest.evalSuite,
				// Identifier only, never a corpus path. runSuite consumes resolved tasks.
				dataset: `${corpusDatasetLabel(visibility, corpus.metadata.id)}.jsonl`,
			},
		},
		tasks,
		// CorpusMetadata.hash is the canonical hash verified by loadCorpus.
		datasetHash: corpus.metadata.hash,
		// Identity as well as content participates in reuse provenance. A
		// same-content corpus imported under another snapshot id is not exact.
		suiteHash: hashValue({
			schemaVersion: 1,
			corpus: { id: corpus.metadata.id, hash: corpus.metadata.hash, visibility },
			effectiveGraders: "explicit-per-task",
			judge: target.manifest.evalSuite.judge ?? null,
		}),
	};
}

export function targetWithDevelopmentCorpus(target: ResolvedTarget, corpus: LoadedCorpus): ResolvedTarget {
	if (corpus.metadata.visibility !== "development") {
		throw new Error(
			`development evaluation requires a development corpus, got ${corpus.metadata.visibility} (${corpus.metadata.id})`,
		);
	}
	return targetWithCorpus(target, corpus, "development");
}

export function targetWithSealedCorpus(target: ResolvedTarget, corpus: LoadedCorpus): ResolvedTarget {
	if (corpus.metadata.visibility !== "sealed") {
		throw new Error(
			`candidate holdout requires a sealed corpus, got ${corpus.metadata.visibility} (${corpus.metadata.id})`,
		);
	}
	return targetWithCorpus(target, corpus, "sealed");
}

/**
 * Reconstruct the exact development target used by an immutable eval. The
 * manifest dataset wins only on a full dataset/hash/suite match; otherwise a
 * published development corpus must match both its canonical label and hash.
 */
export function resolveDevelopmentTargetForEval(options: {
	target: ResolvedTarget;
	evalRun: Pick<EvalRunRecord, "target" | "dataset" | "datasetHash" | "suiteHash">;
	stateRoot: string;
	projectId: string;
}): { target: ResolvedTarget; corpus: LoadedCorpus | null } {
	const { target, evalRun } = options;
	if (target.manifest.id !== evalRun.target.id || target.gitSha !== evalRun.target.gitSha) {
		throw new Error(
			`development evidence belongs to ${evalRun.target.id}@${evalRun.target.gitSha}, ` +
				`not ${target.manifest.id}@${target.gitSha}`,
		);
	}
	if (evalSurfaceMatches(target, evalRun)) return { target, corpus: null };

	const matches = listCorpora({ stateRoot: options.stateRoot, projectId: options.projectId })
		.filter((metadata) => (
			metadata.visibility === "development" &&
			corpusDatasetLabel("development", metadata.id) === evalRun.dataset &&
			metadata.hash === evalRun.datasetHash
		));
	if (matches.length !== 1) {
		throw new Error(
			"cannot reconstruct the exact development evaluation surface from the target manifest or " +
				`a published corpus: ${evalRun.dataset}/${evalRun.datasetHash}/${evalRun.suiteHash}`,
		);
	}
	const corpus = loadCorpus({
		stateRoot: options.stateRoot,
		projectId: options.projectId,
		corpusId: matches[0]!.id,
	});
	const resolved = targetWithDevelopmentCorpus(target, corpus);
	assertEvalSurfaceMatches(resolved, evalRun, "published development corpus");
	return { target: resolved, corpus };
}
