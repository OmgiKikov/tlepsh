import { loadCandidateRecord } from "../application/candidate-review.js";
import { runCost } from "../compare.js";
import { isSealedEvalRun, listEvalRunIndexes, loadRun, readEvalRunIndex } from "../eval.js";

/**
 * What a measurement actually cost, read back from the records it wrote.
 *
 * Nothing here estimates: every number is summed from an EvalRun index and its
 * member Run records, and a measurement whose records cannot be read reports
 * `null` instead of a guess. Nothing is written, and a sealed EvalRun is never
 * opened — the exam contributes neither a cost nor a duration, because reading
 * one would be reading the exam.
 *
 * Reads are memoized per process: an immutable EvalRun cannot change its cost,
 * so the second reader of the same receipt pays nothing.
 */

/** Member runs one spend read will open. A huge eval cannot make a redraw slow. */
const MAX_MEMBER_RUNS = 1_000;
/** Eval runs the cycle-spend scan will consider, newest first. */
const MAX_SCANNED_EVALS = 40;
/** Candidate records the last-promotion scan will open. */
const MAX_SCANNED_CANDIDATES = 60;

export interface EvalRunSpend {
	evalRunId: string;
	/** Target executions this EvalRun recorded. */
	runs: number;
	/** Target + recorded simulated-user spend; null if any member cost is unknown or unreadable. */
	costUsd: number | null;
	/** Recorded grading spend, null when member records are incomplete. */
	judgeCostUsd: number | null;
	startedAt: string;
	finishedAt: string;
}

/** Spend of one improvement cycle: every development measurement since the last promotion. */
export interface CycleSpend {
	costUsd: number | null;
	judgeCostUsd: number | null;
	evals: number;
	/** Start of the oldest measurement counted, or null when nothing has run. */
	firstAt: string | null;
	/** When the promotion that opened this cycle happened, or null. */
	sinceAt: string | null;
}

/** Which measurements belong to the cycle the operator is standing in. */
export interface CycleScope {
	/** Only this Target's measurements are summed. */
	targetId?: string | null;
	/** Candidates the current view knows about; the promotion scan stays inside them. */
	candidateIds?: readonly string[];
}

export interface BuilderSpendReader {
	/** One measurement's receipt, or null when its records are unreadable or sealed. */
	ofEvalRun(evalRunId: string): EvalRunSpend | null;
	/** Both development arms of one candidate — never its sealed arm. */
	ofCandidate(candidateId: string): EvalRunSpend[];
	/** Development spend since the newest promotion, or null when it cannot be read. */
	cycle(scope?: CycleScope): CycleSpend | null;
	/** The branch an applied candidate lives on, or null. */
	branchOf(candidateId: string): string | null;
}

function sumMembers(runsRoot: string, runIds: readonly string[]): { costUsd: number | null; judgeCostUsd: number | null } {
	let costUsd: number | null = runIds.length > MAX_MEMBER_RUNS ? null : 0;
	let judgeCostUsd: number | null = runIds.length > MAX_MEMBER_RUNS ? null : 0;
	let read = 0;
	for (const runId of runIds.slice(0, MAX_MEMBER_RUNS)) {
		try {
			const run = loadRun(runsRoot, runId);
			const targetCost = runCost(run);
			costUsd = costUsd === null || targetCost === null
				? null
				: costUsd + targetCost + (run.metrics.simulatedUser?.costUsd ?? 0);
			if (judgeCostUsd !== null) judgeCostUsd += run.metrics.judge?.costUsd ?? 0;
			read += 1;
		} catch {
			// A partial sum cannot stand in for the whole measurement.
			costUsd = null;
			judgeCostUsd = null;
		}
	}
	return { costUsd: read === 0 ? null : costUsd, judgeCostUsd };
}

/**
 * The development arms of one candidate, in the order they were measured. The
 * sealed arm is deliberately not returned: its identity is not the host's to
 * project, and its cost would leak the size of the exam.
 */
function developmentArms(runsRoot: string, candidateId: string): string[] {
	const record = loadCandidateRecord(runsRoot, candidateId);
	for (let index = record.events.length - 1; index >= 0; index -= 1) {
		const event = record.events[index];
		if (event?.type !== "evaluated") continue;
		const development = event.evaluation.development;
		return [development.baseline.evalRunId, development.candidate.evalRunId];
	}
	return [];
}

function builtBranch(runsRoot: string, candidateId: string): string | null {
	const record = loadCandidateRecord(runsRoot, candidateId);
	for (let index = record.events.length - 1; index >= 0; index -= 1) {
		const event = record.events[index];
		if (event?.type === "built") return event.candidate.ref;
	}
	return null;
}

function newestPromotionAt(runsRoot: string, candidateIds: readonly string[]): string | null {
	let newest: string | null = null;
	for (const candidateId of candidateIds.slice(0, MAX_SCANNED_CANDIDATES)) {
		let record: ReturnType<typeof loadCandidateRecord>;
		try {
			record = loadCandidateRecord(runsRoot, candidateId);
		} catch {
			continue;
		}
		for (const event of record.events) {
			if (event.type !== "promoted") continue;
			if (newest === null || event.at > newest) newest = event.at;
		}
	}
	return newest;
}

export interface BuilderSpendOptions {
	runsRoot: string;
	/** Wall clock for the short cycle-sum cache; injected by tests. */
	now?: () => number;
}

/**
 * How long one cycle sum is reused. The header refreshes after every tool call,
 * and the sum walks candidate records: a few seconds of staleness in a money
 * segment is cheaper than reading the same immutable records forty times.
 */
const CYCLE_CACHE_MS = 5_000;

/**
 * One reader per Builder process. Every method fails soft: an unreadable
 * artifact removes a number from a status line, never a receipt from history.
 */
export function createBuilderSpendReader(options: BuilderSpendOptions): BuilderSpendReader {
	const evalCache = new Map<string, EvalRunSpend | null>();
	const branchCache = new Map<string, string | null>();
	const armsCache = new Map<string, string[]>();
	const now = options.now ?? (() => Date.now());
	let cycleCache: { key: string; at: number; value: CycleSpend | null } | null = null;

	const ofEvalRun = (evalRunId: string): EvalRunSpend | null => {
		if (evalCache.has(evalRunId)) return evalCache.get(evalRunId) ?? null;
		let spend: EvalRunSpend | null = null;
		try {
			const index = readEvalRunIndex(options.runsRoot, evalRunId);
			// Invariant 5: a sealed measurement is not projected, not even as money.
			if (!isSealedEvalRun(index)) {
				const members = sumMembers(options.runsRoot, index.runIds);
				spend = {
					evalRunId,
					runs: index.runIds.length,
					costUsd: members.costUsd,
					judgeCostUsd: index.judgeCostUsd ?? members.judgeCostUsd,
					startedAt: index.startedAt,
					finishedAt: index.finishedAt,
				};
			}
		} catch {
			spend = null;
		}
		evalCache.set(evalRunId, spend);
		return spend;
	};

	const ofCandidate = (candidateId: string): EvalRunSpend[] => {
		let arms = armsCache.get(candidateId);
		if (!arms) {
			try {
				arms = developmentArms(options.runsRoot, candidateId);
			} catch {
				arms = [];
			}
			armsCache.set(candidateId, arms);
		}
		const spends: EvalRunSpend[] = [];
		for (const evalRunId of arms) {
			const spend = ofEvalRun(evalRunId);
			if (!spend) return [];
			spends.push(spend);
		}
		return spends;
	};

	return {
		ofEvalRun,
		ofCandidate,
		branchOf(candidateId) {
			if (branchCache.has(candidateId)) return branchCache.get(candidateId) ?? null;
			let branch: string | null = null;
			try {
				branch = builtBranch(options.runsRoot, candidateId);
			} catch {
				branch = null;
			}
			branchCache.set(candidateId, branch);
			return branch;
		},
		cycle(scope = {}) {
			const targetId = scope.targetId ?? null;
			const candidateIds = scope.candidateIds ?? [];
			const key = `${targetId ?? ""}|${candidateIds.join(",")}`;
			if (cycleCache && cycleCache.key === key && now() - cycleCache.at < CYCLE_CACHE_MS) {
				return cycleCache.value;
			}
			let indexes: ReturnType<typeof listEvalRunIndexes>;
			try {
				indexes = listEvalRunIndexes(options.runsRoot);
			} catch {
				cycleCache = { key, at: now(), value: null };
				return null;
			}
			const sinceAt = newestPromotionAt(options.runsRoot, candidateIds);
			const eligible = indexes.filter((index) => !isSealedEvalRun(index) &&
				(!targetId || index.target.id === targetId) && (!sinceAt || index.startedAt >= sinceAt));
			let costUsd: number | null = eligible.length > MAX_SCANNED_EVALS ? null : 0;
			let judgeCostUsd: number | null = eligible.length > MAX_SCANNED_EVALS ? null : 0;
			let evals = 0;
			let firstAt: string | null = null;
			for (const index of eligible.slice(0, MAX_SCANNED_EVALS)) {
				const spend = ofEvalRun(index.evalRunId);
				if (!spend) {
					costUsd = null;
					judgeCostUsd = null;
					continue;
				}
				costUsd = costUsd === null || spend.costUsd === null ? null : costUsd + spend.costUsd;
				judgeCostUsd = judgeCostUsd === null || spend.judgeCostUsd === null ? null : judgeCostUsd + spend.judgeCostUsd;
				evals += 1;
				if (firstAt === null || spend.startedAt < firstAt) firstAt = spend.startedAt;
			}
			const value: CycleSpend = { costUsd, judgeCostUsd, evals, firstAt, sinceAt };
			cycleCache = { key, at: now(), value };
			return value;
		},
	};
}
