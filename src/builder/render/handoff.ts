import { t } from "../../i18n.js";
import type { WorkbenchDecisionResult } from "../../workbench/types.js";
import type { Paint } from "./paint.js";

/**
 * The line that ends the two moments where an agent starts existing for its
 * operator: the first change that was applied and actually checked, and the
 * release. Until then there is nothing to talk to and the offer would be a
 * lie; after either one, the next thing a person wants is not another
 * Workbench step but the agent itself.
 *
 * It names the command in the shell rather than opening anything, because the
 * Target runs in its own Pi with its own credential: this Builder session is
 * not where that conversation happens.
 */
export function handoffLines(result: WorkbenchDecisionResult, paint: Paint): string[] {
	if (result.view.target.status !== "ready") return [];
	const verified = result.kind === "apply-proposal" &&
		result.result.verification !== undefined &&
		result.result.verification.outcome !== "blocked";
	if (result.kind !== "ship" && !verified) return [];
	return ["", paint.accent(t("handoff.talk-to-agent"))];
}
