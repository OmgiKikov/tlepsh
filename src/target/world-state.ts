import { existsSync } from "node:fs";
import { join } from "node:path";
import { readWorldStateFile } from "../domain/world.js";
import type { World } from "../manifest.js";

/**
 * Where a run's world lives, and how anything downstream reads it back.
 *
 * The world is written under `runtime/`, deliberately OUTSIDE `workspace/`:
 * `workspaceTreeHash` and the shared per-EvalRun snapshot (invariant 19) are
 * the Target's identity, and a case's starting state is not part of it. Two
 * cases with different worlds must materialize the same workspace, or every
 * comparison between them would be comparing two Targets.
 */

/** The run-relative segments, in one list, so the writer and the readers agree. */
export const WORLD_STATE_SEGMENTS = ["runtime", "world", "state.json"] as const;

/** The absolute path of one run's world file. */
export function worldStatePath(runDir: string): string {
	return join(runDir, ...WORLD_STATE_SEGMENTS);
}

/**
 * The world the conversation left behind, or `null` when the case declared
 * none. An unreadable, oversized or malformed file throws: it says nothing
 * about the agent, and a caller that treated it as an answer would be
 * inventing one (invariant 9).
 */
export function readFinalWorldState(runDir: string): World["state"] | null {
	const path = worldStatePath(runDir);
	if (!existsSync(path)) return null;
	return readWorldStateFile(path);
}
