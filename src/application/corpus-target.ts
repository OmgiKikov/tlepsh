import {
	listCorpora,
	loadCorpus,
	type CorpusVisibility,
	type LoadedCorpus,
} from "../corpus.js";
import type { EvalRunRecord } from "../eval.js";
import {
	graderNeedsExpected,
	hasReferenceAnswer,
	type GraderSpec,
	type ResolvedTarget,
	type TargetManifest,
} from "../manifest.js";
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
		for (const grader of graders) {
			if (graderNeedsExpected(grader) && !hasReferenceAnswer(task)) {
				throw new Error(
					`${visibility} corpus ${corpus.metadata.id} task ${task.id} pairs a ${grader.type} grader with a case that has no "expected" reference answer`,
				);
			}
		}
		return {
			id: task.id,
			input: task.input,
			// Reference answers and dialogue history travel with the corpus case:
			// the runner seeds the turns and the graders compare with `expected`.
			...(task.expected !== undefined ? { expected: task.expected } : {}),
			...(task.messages !== undefined ? { messages: task.messages } : {}),
			...(task.metadata !== undefined ? { metadata: task.metadata } : {}),
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

/**
 * Reconstruct the exact case set an immutable eval scored, so its recorded
 * traces can be re-graded.
 *
 * Unlike {@link resolveDevelopmentTargetForEval} this deliberately ignores the
 * Target revision and the recorded suite hash: changing the graders is the whole
 * point of a regrade, and editing `evals/graders.yaml` already makes the
 * checkout dirty. Only the cases themselves — dataset label and dataset hash —
 * must be the exact ones the recorded traces answered.
 */
export function resolveScoredCasesForEval(options: {
	target: ResolvedTarget;
	evalRun: Pick<EvalRunRecord, "target" | "dataset" | "datasetHash">;
	stateRoot: string;
	projectId: string;
}): { target: ResolvedTarget; corpus: LoadedCorpus | null } {
	const { target, evalRun } = options;
	if (target.manifest.id !== evalRun.target.id) {
		throw new Error(`evidence belongs to target ${evalRun.target.id}, not ${target.manifest.id}`);
	}
	const surface = targetEvalSurface(target);
	if (surface.dataset === evalRun.dataset && surface.datasetHash === evalRun.datasetHash) {
		return { target, corpus: null };
	}
	const matches = listCorpora({ stateRoot: options.stateRoot, projectId: options.projectId })
		.filter((metadata) => (
			metadata.visibility === "development" &&
			corpusDatasetLabel("development", metadata.id) === evalRun.dataset &&
			metadata.hash === evalRun.datasetHash
		));
	if (matches.length !== 1) {
		throw new Error(
			"cannot reconstruct the exact scored cases from the target manifest or a published corpus: " +
				`${evalRun.dataset}/${evalRun.datasetHash}`,
		);
	}
	const corpus = loadCorpus({
		stateRoot: options.stateRoot,
		projectId: options.projectId,
		corpusId: matches[0]!.id,
	});
	const resolved = targetWithDevelopmentCorpus(target, corpus);
	if (resolved.datasetHash !== evalRun.datasetHash) {
		throw new Error(
			`published development corpus ${corpus.metadata.id} does not carry the scored cases: ` +
				`expected ${evalRun.datasetHash}, got ${resolved.datasetHash}`,
		);
	}
	return { target: resolved, corpus };
}

/**
 * Reject graders the current Target could never run *before* a draft or a
 * publication is persisted. Composition (`targetWithDevelopmentCorpus`) makes
 * the same checks later; this earlier, model-readable failure keeps a bad
 * regex or an unsupported judge grader from blocking a reviewed basket.
 */
export function assertGradersRunnable(
	tasks: readonly { expected?: string | undefined; graders?: readonly GraderSpec[] }[],
	manifest: Pick<TargetManifest, "evalSuite">,
	label = "corpus draft",
): void {
	const problems: string[] = [];
	tasks.forEach((task, taskIndex) => {
		(task.graders ?? []).forEach((grader, graderIndex) => {
			const where = `task ${taskIndex + 1} grader ${graderIndex + 1}`;
			if (grader.type === "output_matches") {
				try {
					new RegExp(grader.pattern);
				} catch (error) {
					problems.push(
						`${where}: output_matches pattern ${JSON.stringify(grader.pattern)} is not a valid JavaScript regular expression` +
						` (${error instanceof Error ? error.message : String(error)}). Inline flags such as (?i) or (?s) are not supported;` +
						" use character classes like [Цц] or a simpler pattern.",
					);
				}
			}
			if (grader.type === "judge" && !manifest.evalSuite.judge) {
				problems.push(
					`${where}: judge graders need a judge model configured in the Target manifest (evalSuite.judge), and this Target has none.` +
					" Use output_contains, output_matches, or tool_called instead, or ask the operator to configure a judge model first.",
				);
			}
			if (graderNeedsExpected(grader) && !hasReferenceAnswer(task)) {
				problems.push(
					`${where}: ${grader.type} graders compare the answer with the case's reference answer, and this case has no "expected".` +
					" Give the case an expected answer, or use output_contains, output_matches, or tool_called instead.",
				);
			}
		});
	});
	if (problems.length > 0) {
		throw new Error(`${label} cannot run on the current Target:\n- ${problems.slice(0, 8).join("\n- ")}`);
	}
}
