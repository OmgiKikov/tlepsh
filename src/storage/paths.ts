import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const SAFE_ARTIFACT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

function contained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Validate an identifier or fixed artifact filename before it enters a path. */
export function safeArtifactSegment(value: string, label = "artifact path segment"): string {
	if (!SAFE_ARTIFACT_SEGMENT.test(value)) {
		throw new Error(
			`${label} ${JSON.stringify(value)} must match ${SAFE_ARTIFACT_SEGMENT.source}; path separators and traversal are forbidden`,
		);
	}
	return value;
}

/**
 * Resolve a path below a configured artifact root without following symlinked
 * roots or existing descendants. Missing final descendants are allowed so the
 * same resolver can protect both reads and atomic publications.
 */
export function resolveContainedArtifactPath(
	rootInput: string,
	artifactIdInput: string,
	...descendantInputs: string[]
): string {
	const requestedRoot = resolve(rootInput);
	let rootEntry;
	try {
		rootEntry = lstatSync(requestedRoot);
	} catch (error) {
		throw new Error(`artifact root cannot be inspected: ${requestedRoot}`, { cause: error });
	}
	if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
		throw new Error(`artifact root must be a regular non-symlink directory: ${requestedRoot}`);
	}
	const root = realpathSync(requestedRoot);

	const artifactId = safeArtifactSegment(artifactIdInput, "artifact id");
	const descendants = descendantInputs.map((segment) => safeArtifactSegment(segment));
	const candidate = resolve(root, artifactId, ...descendants);
	if (!contained(root, candidate)) throw new Error(`artifact path escaped configured root: ${candidate}`);

	let current = root;
	for (const segment of [artifactId, ...descendants]) {
		current = join(current, segment);
		if (!existsSync(current)) break;
		const entry = lstatSync(current);
		if (entry.isSymbolicLink()) throw new Error(`artifact path must not traverse a symlink: ${current}`);
		const canonical = realpathSync(current);
		if (!contained(root, canonical)) throw new Error(`artifact path escaped configured root: ${canonical}`);
	}
	return candidate;
}
