import { z } from "zod";
import { readWorldStateFile } from "./domain/world.js";
import { hashValue, type RunRecord } from "./provenance.js";
import { readJsonArtifact } from "./storage/artifacts.js";
import { resolveContainedArtifactPath } from "./storage/paths.js";

const JsonObject = z.record(z.string(), z.unknown());
const MAX_VERDICT_BYTES = 1024 * 1024;

/**
 * Sidecar values whose identities were proved against one RunRecord.
 * Consumers receive values, never paths: after verification, a renderer cannot
 * accidentally reopen mutable bytes and describe a different run.
 */
export interface VerifiedRunArtifacts {
	world: Record<string, unknown> | null;
	judge: Record<string, Record<string, unknown>>;
}

export function readRunJudgeVerdict(runsRoot: string, runId: string, index: string): Record<string, unknown> {
	if (!/^\d{1,3}$/.test(index)) throw new Error("invalid judge artifact index");
	return readJsonArtifact(resolveContainedArtifactPath(runsRoot, runId, "judge", `${index}.verdict.json`), JsonObject, { maxBytes: MAX_VERDICT_BYTES });
}

/** Read the exact values whose hashes are pinned by run.json and the eval index. */
export function verifiedRunArtifacts(runsRoot: string, run: RunRecord): VerifiedRunArtifacts {
	const refs = run.evidenceArtifacts;
	// Legacy sidecars were not attested. Never silently promote them to evidence.
	if (!refs) return { world: null, judge: {} };
	const world = refs.world === null ? null : readWorldStateFile(
		resolveContainedArtifactPath(runsRoot, run.runId, "runtime", "world", "state.json"),
	);
	if (world !== null && hashValue(world) !== refs.world) throw new Error(`run ${run.runId} world artifact hash mismatch`);
	const judge = Object.fromEntries(Object.entries(refs.judge).map(([index, expected]) => {
		const value = readRunJudgeVerdict(runsRoot, run.runId, index);
		if (hashValue(value) !== expected) throw new Error(`run ${run.runId} judge artifact ${index} hash mismatch`);
		return [index, value];
	}));
	return { world, judge };
}
