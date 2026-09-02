import { t } from "../../i18n.js";
import type { ToolFixtureRunResult } from "../../application/tool-workshop.js";
import type { WorkbenchReviewDetail } from "../../workbench/types.js";
import { oneLine } from "./format.js";
import type { Paint } from "./paint.js";
import { renderToolPermissions, toolPermissionsFromDiff } from "./tool-permissions.js";
import { renderReview } from "./view.js";

/**
 * The panel a closed Workshop puts on screen.
 *
 * This is the review the operator asked for, in the order they asked for it:
 * what was created, what it is allowed to reach, whether its own tests passed,
 * the complete diff, and the two things that can happen next. Everything in it
 * is derived from the exact proposal and the tests of the tools it declares —
 * nothing is a claim the model made about its work.
 */
export function renderWorkshopCloseReview(
	content: Extract<WorkbenchReviewDetail, { kind: "proposal" | "applied-proposal" }>,
	runs: readonly ToolFixtureRunResult[],
	paint: Paint,
): string[] {
	const permissions = renderToolPermissions(toolPermissionsFromDiff(content.exactDiff), paint);
	return [
		paint.bold(t("panel.created-changed")),
		...content.paths.map((path) => `  • ${oneLine(path, 120)}`),
		...(permissions.length > 0 ? ["", ...permissions] : []),
		...(runs.length > 0 ? ["", paint.bold(t("panel.tool-tests")), ...fixtureLines(runs, paint)] : []),
		"",
		...renderReview(content, paint, { maxDiffLines: Number.MAX_SAFE_INTEGER }),
		"",
		paint.bold(t("panel.two-outcomes")),
		paint.muted(t("panel.two-outcomes-hint")),
	];
}

/** `✓ 3/3 fixtures`, or the first failure and why, per tool. */
export function fixtureLines(runs: readonly ToolFixtureRunResult[], paint: Paint): string[] {
	return runs.map((run) => {
		if (run.total === 0) return `  ${paint.warning("—")} ${paint.bold(run.tool)} ${paint.dim(t("fixtures.none"))}`;
		if (run.allPassed) {
			return `  ${paint.success("✓")} ${paint.bold(run.tool)} ${
				t("fixtures.all-passed", { passed: run.passed, total: run.total })
			}`;
		}
		const failed = run.fixtures.find((fixture) => !fixture.passed);
		return `  ${paint.error("✗")} ${paint.bold(run.tool)} ${t("fixtures.failed", {
			passed: run.passed,
			total: run.total,
			fixture: failed?.name ?? "?",
			reason: oneLine(failed?.failures.join("; ") || "failed", 100),
		})}`;
	});
}
