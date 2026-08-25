import { createHash } from "node:crypto";

/** Canonical JSON: objects with sorted keys, arrays preserve order. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function hashValue(value: unknown): string {
	return `sha256:${sha256Hex(canonicalJson(value))}`;
}

export function hashFile(content: string): string {
	return `sha256:${sha256Hex(content)}`;
}

/** Execution lifecycle of a run (pass/fail lives in evalResults.outcome). */
export type RunStatus = "running" | "completed" | "error";
export type EvalOutcome = "pass" | "fail";

export const GraderResultSchema = {
	type: "object",
} as const;

export interface GraderResult {
	name: string;
	type: string;
	passed: boolean;
	score: number;
	reason: string;
}

export interface TokenMetrics {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface RunMetrics {
	tokens: TokenMetrics;
	costUsd: number;
	latencyMs: number;
	toolCalls: number;
	toolErrors: number;
	recoveryAttempts: number;
}

export interface RunRecord {
	schemaVersion: 1;
	runId: string;
	taskId: string;
	repetitionIndex: number;
	label: "baseline" | "candidate" | "solo";
	status: RunStatus;
	error: string | null;
	startedAt: string;
	finishedAt: string | null;
	target: { id: string; gitSha: string };
	runtime: { piVersion: string; piSha: string; ahdeVersion: string; ahdeCodeHash: string };
	model: { provider: string; id: string; thinkingLevel: string; params: Record<string, unknown> };
	eval: { suiteId: string; suiteHash: string; dataset: string; datasetHash: string };
	trace: { path: string; sessionId: string | null; sha256: string | null };
	metrics: RunMetrics;
	evalResults: { graders: GraderResult[]; outcome: EvalOutcome } | null;
	parent: { evalRunId: string; candidateOf: string | null } | null;
}

/**
 * The provenance axes compared between two runs. The target git SHA is
 * deliberately NOT an axis: baseline and candidate differ exactly there.
 */
export interface ProvenanceAxes {
	piVersion: string;
	piSha: string;
	ahdeVersion: string;
	ahdeCodeHash: string;
	provider: string;
	modelId: string;
	thinkingLevel: string;
	params: Record<string, unknown>;
	suiteHash: string;
	datasetHash: string;
}

export function provenanceAxes(record: {
	runtime: { piVersion: string; piSha: string; ahdeVersion: string; ahdeCodeHash: string };
	model: { provider: string; id: string; thinkingLevel: string; params: Record<string, unknown> };
	eval: { suiteHash: string; datasetHash: string };
}): ProvenanceAxes {
	return {
		piVersion: record.runtime.piVersion,
		piSha: record.runtime.piSha,
		ahdeVersion: record.runtime.ahdeVersion,
		ahdeCodeHash: record.runtime.ahdeCodeHash,
		provider: record.model.provider,
		modelId: record.model.id,
		thinkingLevel: record.model.thinkingLevel,
		params: record.model.params,
		suiteHash: record.eval.suiteHash,
		datasetHash: record.eval.datasetHash,
	};
}

export function provenanceKey(record: Parameters<typeof provenanceAxes>[0]): string {
	return hashValue(provenanceAxes(record));
}

const AXIS_LABELS: Record<keyof ProvenanceAxes, string> = {
	piVersion: "runtime.piVersion",
	piSha: "runtime.piSha",
	ahdeVersion: "runtime.ahdeVersion",
	ahdeCodeHash: "runtime.ahdeCodeHash",
	provider: "model.provider",
	modelId: "model.id",
	thinkingLevel: "model.thinkingLevel",
	params: "model.params",
	suiteHash: "eval.suiteHash",
	datasetHash: "eval.datasetHash",
};

/** Names of axes that differ between two runs; empty array means comparable. */
export function axisDifferences(a: ProvenanceAxes, b: ProvenanceAxes): string[] {
	const diffs: string[] = [];
	for (const key of Object.keys(AXIS_LABELS) as (keyof ProvenanceAxes)[]) {
		const av = a[key];
		const bv = b[key];
		if (typeof av === "object" || typeof bv === "object") {
			if (canonicalJson(av) !== canonicalJson(bv)) diffs.push(AXIS_LABELS[key]);
		} else if (av !== bv) {
			diffs.push(AXIS_LABELS[key]);
		}
	}
	return diffs;
}

export function comparable(a: ProvenanceAxes, b: ProvenanceAxes): boolean {
	return axisDifferences(a, b).length === 0;
}
