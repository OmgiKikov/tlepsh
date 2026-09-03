/**
 * One matcher for the declared harness surface.
 *
 * `manifest.harness.files` is read by two sides that must not drift: the WRITE
 * side decides what a proposal may change, the READ side decides what the
 * Builder may look at. When those two disagree the loop breaks in the worst
 * possible way — the Builder is told to fix a file it is not allowed to read,
 * or reads one it may never change. So both call the functions here, and the
 * agreement is by construction rather than by review.
 *
 * The glob language is deliberately tiny, and exactly as wide as
 * `HarnessGlob` in `src/manifest.ts` allows:
 *
 *   - a literal segment matches itself;
 *   - `*` inside one segment matches any run of characters within that
 *     segment, never a `/`;
 *   - `**` as a whole segment stands for ONE OR MORE segments.
 *
 * "One or more" is the load-bearing choice: it makes `prompts/**` mean exactly
 * `path.startsWith("prompts/")`, which is what the write side has always meant
 * by `data/**` and `skills/**`. A `**` that also matched zero segments would
 * quietly turn the directory itself into a member of its own surface.
 */

/**
 * What a Pi Target's harness is when the manifest does not say. Exactly the
 * surface `ahde` has always been willing to rewrite. It lives here, with the
 * matcher, so that this module stays free of every dependency and `manifest.ts`
 * can consult the matcher while validating a manifest.
 */
export const DEFAULT_PI_HARNESS_FILES = ["AGENTS.md", "skills/**", "tools/**", "bin/**"] as const;

/** Path segments a declared surface may never contain, whatever it globs. */
function unsafeSegment(segment: string): boolean {
	return segment.length === 0 || segment === "." || segment === "..";
}

/**
 * Is this a path a declared harness surface may name at all? Traversal, an
 * absolute root, a backslash or a control character fails closed before any
 * glob is consulted. Hidden files are refused a layer up, by the readers that
 * enumerate a surface, so that this stays exactly the write side's old rule
 * plus traversal.
 */
export function safeHarnessPath(path: string): boolean {
	if (typeof path !== "string" || path.length === 0 || path.length > 500) return false;
	if (path !== path.trim() || path.startsWith("/") || path.includes("\\") || /[\0\r\n]/.test(path)) return false;
	return !path.split("/").some(unsafeSegment);
}

/** `*` inside one segment: any run of characters, but never a separator. */
function matchesSegment(value: string, pattern: string): boolean {
	if (!pattern.includes("*")) return value === pattern;
	const parts = pattern.split("*");
	const first = parts[0] as string;
	const last = parts[parts.length - 1] as string;
	if (!value.startsWith(first)) return false;
	if (value.length < first.length + last.length || !value.endsWith(last)) return false;
	let cursor = first.length;
	for (const middle of parts.slice(1, -1)) {
		if (middle.length === 0) continue;
		const found = value.indexOf(middle, cursor);
		if (found < 0 || found + middle.length > value.length - last.length) return false;
		cursor = found + middle.length;
	}
	return true;
}

function matchesFrom(path: readonly string[], pathIndex: number, glob: readonly string[], globIndex: number): boolean {
	if (globIndex === glob.length) return pathIndex === path.length;
	const segment = glob[globIndex] as string;
	if (segment === "**") {
		// One or more segments, so `prompts/**` is every file under prompts/ and
		// never `prompts` itself.
		for (let next = pathIndex + 1; next <= path.length; next += 1) {
			if (matchesFrom(path, next, glob, globIndex + 1)) return true;
		}
		return false;
	}
	if (pathIndex >= path.length) return false;
	if (!matchesSegment(path[pathIndex] as string, segment)) return false;
	return matchesFrom(path, pathIndex + 1, glob, globIndex + 1);
}

/** One declared path or glob against one repository-relative path. */
export function matchesHarnessGlob(path: string, glob: string): boolean {
	if (!safeHarnessPath(path)) return false;
	if (typeof glob !== "string" || glob.length === 0 || glob.split("/").some(unsafeSegment)) return false;
	return matchesFrom(path.split("/"), 0, glob.split("/"), 0);
}

/** Is this path inside the surface the manifest declares? */
export function withinDeclaredHarness(path: string, declared: readonly string[]): boolean {
	return declared.some((glob) => matchesHarnessGlob(path, glob));
}

/**
 * Is the declared surface exactly the Pi layout AHDE has always rewritten?
 *
 * Every reader asks this before it does anything new, so a Pi Target's
 * authoring context, workshop scope, resource list and policy id stay byte for
 * byte what they were before `harness.files` existed.
 */
export function isDefaultPiHarness(declared: readonly string[]): boolean {
	return declared.length === DEFAULT_PI_HARNESS_FILES.length &&
		declared.every((glob, index) => glob === DEFAULT_PI_HARNESS_FILES[index]);
}

/**
 * The literal directory prefixes of a declared surface: what a listing has to
 * walk, and the words a refusal uses. An empty result means "the whole tree",
 * which only happens when a glob's very first segment is a wildcard.
 */
export function declaredHarnessRoots(declared: readonly string[]): string[] {
	const roots: string[] = [];
	for (const glob of declared) {
		const segments = glob.split("/");
		const wildcard = segments.findIndex((segment) => segment.includes("*"));
		const literal = wildcard < 0 ? segments : segments.slice(0, wildcard);
		if (literal.length === 0) return [];
		roots.push(literal.join("/"));
	}
	const unique = [...new Set(roots)].sort((left, right) => left.localeCompare(right));
	// A root nested inside another root is already walked by its parent.
	return unique.filter((root) => !unique.some((other) => other !== root && root.startsWith(`${other}/`)));
}

/**
 * Everything the host owns or the evaluation owns. A declared surface may glob
 * over these paths — the manifest is the operator's to write — but they never
 * become readable authoring resources: `manifest.yaml` carries model and
 * credential configuration, `evals/` and `imports/` carry the very inputs
 * invariant 5 keeps away from the Target, and `data/` is shape-only by
 * invariant 30.
 */
const RESERVED_HARNESS_PATHS = new Set(["manifest.yaml", ".gitignore"]);
const RESERVED_HARNESS_ROOTS = ["data", "evals", "imports", "runs", ".ahde", ".git"];

/** Is this path host-owned or evidence, whatever the manifest declares? */
export function reservedHarnessPath(path: string): boolean {
	if (RESERVED_HARNESS_PATHS.has(path)) return true;
	return RESERVED_HARNESS_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

/**
 * What a candidate, a workshop and a compiled proposal may change, for one
 * declared surface.
 *
 * The Pi layout is still the answer for a Pi Target — same list, same order —
 * so no existing evidence, policy id or persisted request moves. A Target that
 * declares its own surface gets that surface, plus the two things that are
 * host-owned rather than the agent's program: the manifest AHDE renders and
 * the declared data directories.
 */
export const PI_HARNESS_SCOPE_PATHS = [
	"AGENTS.md",
	"manifest.yaml",
	"skills/**",
	"bin/**",
	"tools/**",
	"data/**",
] as const;

export function harnessScopePaths(declared: readonly string[]): string[] {
	if (isDefaultPiHarness(declared)) return [...PI_HARNESS_SCOPE_PATHS];
	return ["manifest.yaml", "data/**", ...declared];
}
