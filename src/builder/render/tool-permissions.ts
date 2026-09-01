import { parse as parseYaml } from "yaml";
import { t } from "../../i18n.js";
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
 * It reads the diff and nothing else. AHDE proposals are whole-file diffs, so
 * every `+` line of a `tools/<name>/tool.yaml` is the descriptor exactly as it
 * will exist after Apply; a summary is therefore never a claim about anything
 * but the bytes on screen.
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

const TOOL_DESCRIPTOR = /^tools\/([a-z][a-z0-9_]{0,63})\/tool\.yaml$/;
const MAX_TOOLS = 32;

/** One diff, split into the per-file sections `git diff` wrote. */
function fileSections(diff: string): { path: string; lines: string[] }[] {
	const sections: { path: string; lines: string[] }[] = [];
	let current: { path: string; lines: string[] } | null = null;
	for (const line of diff.split("\n")) {
		const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
		if (header) {
			current = { path: header[2] as string, lines: [] };
			sections.push(current);
			continue;
		}
		current?.lines.push(line);
	}
	return sections;
}

function descriptorText(lines: readonly string[]): string | null {
	if (lines.some((line) => line.startsWith("+++ /dev/null"))) return null;
	return lines
		.filter((line) => line.startsWith("+") && !line.startsWith("+++"))
		.map((line) => line.slice(1))
		.join("\n");
}

function stringField(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 && value.length <= 64 ? value : fallback;
}

/** Every new, changed, or removed tool the diff carries, in path order. */
export function toolPermissionsFromDiff(diff: string): ToolPermissionSummary[] {
	const summaries: ToolPermissionSummary[] = [];
	for (const section of fileSections(diff)) {
		const match = TOOL_DESCRIPTOR.exec(section.path);
		if (!match) continue;
		const tool = match[1] as string;
		if (summaries.length >= MAX_TOOLS) break;
		const text = descriptorText(section.lines);
		if (text === null) {
			summaries.push({ tool, removed: true, network: "deny", filesystem: "read-only", environment: [], setup: null });
			continue;
		}
		let descriptor: Record<string, unknown> = {};
		try {
			const parsed: unknown = parseYaml(text);
			if (typeof parsed === "object" && parsed !== null) descriptor = parsed as Record<string, unknown>;
		} catch {
			// A descriptor the host cannot read never reaches Apply; the diff on the
			// same screen is what the operator judges it by.
			continue;
		}
		const permissions = (descriptor.permissions ?? {}) as Record<string, unknown>;
		const setup = descriptor.setup as Record<string, unknown> | undefined;
		const environment = Array.isArray(permissions.environment)
			? permissions.environment.filter((name): name is string => typeof name === "string").slice(0, 16)
			: [];
		summaries.push({
			tool: stringField(descriptor.name, tool),
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
