import { money } from "../../measurement.js";
import type { WorkbenchStage } from "../../workbench/types.js";
import { joinNonEmpty, oneLine } from "./format.js";
import { coarseElapsed } from "./receipt.js";
import { stageLabel } from "./stage.js";

/**
 * The footer segment: where the cycle is, how long it has been going, what it
 * has cost since the last promotion, and the branch the change lives on.
 *
 * Everything is a projection of records that already exist. A number that
 * cannot be read is left out rather than guessed, so the segment shrinks
 * instead of lying.
 */

/** Characters the footer segment may occupy; Pi shares that row with everything else. */
const MAX_STATUS_WIDTH = 72;
const MAX_BRANCH = 24;

export interface StatusBarFacts {
	stage: WorkbenchStage;
	/** Since the first measurement of this cycle, or the session start. */
	elapsedMs?: number | null;
	/** Development spend since the last promotion. */
	costUsd?: number | null;
	/** The candidate branch, when a change is applied on one. */
	branch?: string | null;
}

export function renderStatusBar(facts: StatusBarFacts): string {
	return oneLine(joinNonEmpty([
		`AHDE · ${stageLabel(facts.stage)}`,
		typeof facts.elapsedMs === "number" && facts.elapsedMs >= 0 ? coarseElapsed(facts.elapsedMs) : null,
		typeof facts.costUsd === "number" ? money(facts.costUsd) : null,
		facts.branch ? oneLine(facts.branch, MAX_BRANCH) : null,
	]), MAX_STATUS_WIDTH);
}
