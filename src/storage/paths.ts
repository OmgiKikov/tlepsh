import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const SAFE_ARTIFACT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const ProjectIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

/** True when `candidate` is `root` or lies below it, by path arithmetic alone. */
export function contained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * A private state root: created 0700 on demand, refused when it is a symlink or
 * not a directory, returned canonical. Without `create`, a missing root comes
 * back as requested so a read can report "nothing here" on its own terms.
 */
export function privateStateRoot(input: string, create: boolean, label: string): string {
	const requested = resolve(input);
	if (!existsSync(requested)) {
		if (!create) return requested;
		mkdirSync(requested, { recursive: true, mode: 0o700 });
	}
	const entry = lstatSync(requested);
	if (!entry.isDirectory() || entry.isSymbolicLink()) {
		throw new Error(`${label} stateRoot must be a regular non-symlink directory: ${requested}`);
	}
	if (create) chmodSync(requested, 0o700);
	return realpathSync(requested);
}

/**
 * `<stateRoot>/projects/<projectId>/<leaf…>`: the private directory one module
 * keeps per project. Every segment is created 0700 on demand, refused when it
 * is a symlink or not a directory, and checked to still resolve inside the
 * state root. Without `create`, a missing segment yields null.
 */
export function projectStateDir(
	stateRoot: string,
	projectIdInput: string,
	leaf: string | readonly string[],
	options: { create: boolean; label: string },
): string | null {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const root = resolve(stateRoot);
	if (!existsSync(root)) {
		if (!options.create) return null;
		mkdirSync(root, { recursive: true, mode: 0o700 });
	}
	const rootEntry = lstatSync(root);
	if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
		throw new Error(`${options.label} stateRoot must be a regular non-symlink directory: ${root}`);
	}
	const canonicalRoot = realpathSync(root);
	let current = root;
	for (const segment of ["projects", projectId, ...(typeof leaf === "string" ? [leaf] : leaf)]) {
		const next = join(current, segment);
		if (!existsSync(next)) {
			if (!options.create) return null;
			mkdirSync(next, { mode: 0o700 });
		}
		const entry = lstatSync(next);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(`${options.label} state component must be a regular non-symlink directory: ${next}`);
		}
		if (!contained(canonicalRoot, realpathSync(next))) {
			throw new Error(`${options.label} state path escaped stateRoot`);
		}
		current = next;
	}
	return current;
}

/** A receipt or other private artifact: one regular non-symlink file with mode 0600. */
export function assertPrivateFile(path: string, label: string): void {
	const entry = lstatSync(path);
	if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
	const mode = statSync(path).mode & 0o777;
	if (mode !== 0o600) throw new Error(`${label} must have mode 0600, got 0${mode.toString(8)}`);
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
