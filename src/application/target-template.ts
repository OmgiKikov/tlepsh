import { statSync } from "node:fs";
import { join, resolve } from "node:path";

/** Stable public names; the packaged folder names remain an implementation detail. */
export const BUILT_IN_TARGET_TEMPLATES = {
	"python-support": "python-agent",
	"pi-support": "support-agent",
	"pi-basic": "basic-agent",
} as const;

export const DEFAULT_TARGET_TEMPLATE = "pi-basic";

/**
 * Named starters work from any directory, including a global installation.
 * Explicit relative/absolute paths keep their existing cwd-based meaning.
 * `./python-support` therefore chooses a local template, not the packaged one.
 */
export function resolveTargetTemplate(
	template: string | undefined,
	packageRoot: string,
	cwd = process.cwd(),
): string {
	const selected = template === "python" ? "python-support" : template ?? DEFAULT_TARGET_TEMPLATE;
	const builtIn = Object.hasOwn(BUILT_IN_TARGET_TEMPLATES, selected)
		? BUILT_IN_TARGET_TEMPLATES[selected as keyof typeof BUILT_IN_TARGET_TEMPLATES]
		: undefined;
	const directory = builtIn ? resolve(packageRoot, "templates", builtIn) : resolve(cwd, selected);
	if (!statSync(join(directory, "manifest.yaml"), { throwIfNoEntry: false })?.isFile()) {
		throw new Error(
			`Template ${JSON.stringify(selected)} has no manifest.yaml at ${directory}. ` +
			`Choose ${Object.keys(BUILT_IN_TARGET_TEMPLATES).join(", ")} (python is an alias), ` +
			"or pass a template directory with --template ./path.",
		);
	}
	return directory;
}
