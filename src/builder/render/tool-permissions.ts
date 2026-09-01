import { t } from "../../i18n.js";
import { changedToolDescriptors } from "../../application/tool-contract-cases.js";
import { oneLine } from "./format.js";
import type { Paint } from "./paint.js";

/**
 * What authority the tools in one exact diff ask for.
 *
 * The operator confirms a tool twice: once as a one-question grant for a try
 * inside the Workshop, and once — for real, durably — when they apply the diff.
 * The second question used to show only the diff, which is honest but not
 * readable: `permissions.network: allow` is three words in the middle of a
 * YAML file. This turns the same bytes into a block that says what the change
 * is asking to reach.
 *
 * It reads the diff and nothing else, through the same descriptor reader the
 * contract cases use, so the two never disagree about what a proposal changed.
 */
export interface ToolPermissionSummary {
	tool: string;
	/** The diff removes this tool; there is no authority left to grant. */
	removed: boolean;
	network: string;
	filesystem: string;
	environment: string[];
	/** A declared setup step runs before the tool does, with its own network. */
	setup: { network: string } | null;
}

const MAX_TOOLS = 32;

function stringField(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : fallback;
}

/** Every new, changed, or removed tool the diff carries, in path order. */
export function toolPermissionsFromDiff(diff: string): ToolPermissionSummary[] {
	const summaries: ToolPermissionSummary[] = [];
	for (const entry of changedToolDescriptors(diff).slice(0, MAX_TOOLS)) {
		if (entry.descriptor === null) {
			summaries.push({
				tool: entry.tool,
				removed: true,
				network: "deny",
				filesystem: "read-only",
				environment: [],
				setup: null,
			});
			continue;
		}
		const descriptor = entry.descriptor;
		const permissions = (descriptor.permissions ?? {}) as Record<string, unknown>;
		const setup = descriptor.setup as Record<string, unknown> | undefined;
		const environment = Array.isArray(permissions.environment)
			? permissions.environment.filter((name): name is string => typeof name === "string").slice(0, 16)
			: [];
		summaries.push({
			tool: stringField(descriptor.name, entry.tool),
			removed: false,
			network: stringField(permissions.network, "deny"),
			filesystem: stringField(permissions.filesystem, "read-only"),
			environment,
			setup: setup ? { network: stringField(setup.network, "deny") } : null,
		});
	}
	return summaries;
}

function tone(value: string, paint: Paint): string {
	return value === "allow" || value === "workspace-write" ? paint.warning(value) : paint.success(value);
}

/**
 * The block itself. Values that a policy file, a test, or a script matches on
 * — `deny`, `allow`, `read-only`, `workspace-write`, variable names — are
 * printed exactly as they are; only the labels around them bend.
 */
export function renderToolPermissions(
	summaries: readonly ToolPermissionSummary[],
	paint: Paint,
): string[] {
	if (summaries.length === 0) return [];
	const lines = [paint.bold(t("permissions.title"))];
	for (const summary of summaries) {
		if (summary.removed) {
			lines.push(`  • ${paint.bold(summary.tool)} ${paint.dim(t("permissions.removed"))}`);
			continue;
		}
		const parts = [
			`${paint.dim(t("permissions.network"))} ${tone(summary.network, paint)}`,
			`${paint.dim(t("permissions.filesystem"))} ${tone(summary.filesystem, paint)}`,
			`${paint.dim(t("permissions.env"))} ${
				summary.environment.length === 0 ? paint.success(t("permissions.none")) : paint.warning(summary.environment.join(", "))
			}`,
		];
		if (summary.setup) parts.push(`${paint.dim(t("permissions.setup"))} ${tone(summary.setup.network, paint)}`);
		lines.push(`  • ${paint.bold(oneLine(summary.tool, 64))} ${parts.join(paint.dim(" · "))}`);
	}
	return lines;
}
