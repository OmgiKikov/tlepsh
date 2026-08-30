import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
	type Stats,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import { BUILDER_CORPUS_IMPORT_ROOT } from "./builder-corpus-import-contract.js";

/**
 * Datasets arrive as exports rather than as hand-written baskets, so the inbox
 * bound is larger than the JSONL import bound. Nothing else about the inbox
 * contract changes: one regular non-symlink file under `imports/`, read from a
 * single stable inode that must not move while it is being read.
 */
export const MAX_DATASET_SOURCE_BYTES = 16 * 1024 * 1024;

export const DATASET_SOURCE_EXTENSIONS = [
	".csv",
	".tsv",
	".json",
	".jsonl",
	".ndjson",
	".md",
	".markdown",
	".txt",
	".text",
] as const;

function extensionOf(value: string): string | null {
	const lowered = value.toLowerCase();
	for (const extension of DATASET_SOURCE_EXTENSIONS) {
		if (lowered.endsWith(extension)) return extension;
	}
	return null;
}

/** A dataset may be read only from the explicit project-local inbox. */
export const DatasetSourcePathSchema = z.string().min(1).max(4_096).superRefine((value, context) => {
	if (
		value !== value.trim() ||
		isAbsolute(value) ||
		value.includes("\\") ||
		value.includes("\0") ||
		value.includes("\r") ||
		value.includes("\n")
	) {
		context.addIssue({ code: "custom", message: "sourcePath must be a normalized project-relative path" });
		return;
	}
	const segments = value.split("/");
	if (segments[0] !== BUILDER_CORPUS_IMPORT_ROOT || segments.length < 2) {
		context.addIssue({
			code: "custom",
			message: `sourcePath must be inside the ${BUILDER_CORPUS_IMPORT_ROOT}/ inbox`,
		});
	}
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.startsWith("."))) {
		context.addIssue({ code: "custom", message: "sourcePath contains a forbidden path segment" });
	}
	if (!extensionOf(value)) {
		context.addIssue({
			code: "custom",
			message: `sourcePath must name a file ending in ${DATASET_SOURCE_EXTENSIONS.join(", ")}`,
		});
	}
});

export interface DatasetSourceFile {
	/** Project-relative inbox path, exactly as validated. */
	path: string;
	/** Lowercase extension used as the first format hint. */
	extension: string;
	/** Decoded UTF-8 content, bounded by MAX_DATASET_SOURCE_BYTES. */
	text: string;
	bytes: number;
	sha256: string;
}

export interface ReadDatasetSourceOptions {
	projectDir: string;
	sourcePath: string;
	/** Roots the inbox must never reach into, such as private AHDE state. */
	protectedRoots?: readonly string[];
}

function contained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
	return left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs;
}

function resolveSource(options: ReadDatasetSourceOptions): { absolute: string; relative: string; expected: Stats } {
	const sourcePath = DatasetSourcePathSchema.parse(options.sourcePath);
	const root = resolve(options.projectDir);
	if (!existsSync(root)) throw new Error(`dataset project root does not exist: ${root}`);
	const rootEntry = lstatSync(root);
	if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
		throw new Error(`dataset project root must be a regular non-symlink directory: ${root}`);
	}

	const candidate = resolve(root, sourcePath);
	if (!contained(root, candidate)) throw new Error("dataset source escaped the project root");
	for (const protectedRoot of options.protectedRoots ?? []) {
		if (contained(resolve(protectedRoot), candidate)) {
			throw new Error("dataset source cannot read private AHDE state");
		}
	}

	let current = root;
	let sourceEntry: Stats | null = null;
	const segments = sourcePath.split("/");
	for (const [index, segment] of segments.entries()) {
		current = join(current, segment);
		let entry;
		try {
			entry = lstatSync(current);
		} catch (error) {
			throw new Error(`dataset source cannot be inspected: ${sourcePath}`, { cause: error });
		}
		if (entry.isSymbolicLink()) throw new Error("dataset source may not contain symlink components");
		const final = index === segments.length - 1;
		if (final ? !entry.isFile() : !entry.isDirectory()) {
			throw new Error(`dataset source is not a regular file: ${sourcePath}`);
		}
		if (final) sourceEntry = entry;
	}

	const canonicalRoot = realpathSync(root);
	const canonicalSource = realpathSync(candidate);
	if (!contained(canonicalRoot, canonicalSource)) {
		throw new Error("dataset source escaped the project root through a symlink");
	}
	if (!sourceEntry) throw new Error("dataset source did not resolve to a file");
	return { absolute: canonicalSource, relative: sourcePath, expected: sourceEntry };
}

function readBounded(path: string, expected: Stats): Buffer {
	let descriptor: number;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		throw new Error("dataset source could not be opened safely", { cause: error });
	}
	try {
		const before = fstatSync(descriptor);
		if (!before.isFile()) throw new Error("dataset source must be a regular file");
		if (!sameFileSnapshot(expected, before)) throw new Error("dataset source changed before it was read");
		if (before.size > MAX_DATASET_SOURCE_BYTES) {
			throw new Error(`dataset source exceeds ${MAX_DATASET_SOURCE_BYTES} bytes`);
		}

		const chunks: Buffer[] = [];
		let totalBytes = 0;
		while (totalBytes <= MAX_DATASET_SOURCE_BYTES) {
			const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_DATASET_SOURCE_BYTES + 1 - totalBytes));
			const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
			if (bytesRead === 0) break;
			chunks.push(chunk.subarray(0, bytesRead));
			totalBytes += bytesRead;
		}
		if (totalBytes > MAX_DATASET_SOURCE_BYTES) {
			throw new Error(`dataset source exceeds ${MAX_DATASET_SOURCE_BYTES} bytes`);
		}
		const after = fstatSync(descriptor);
		if (!sameFileSnapshot(before, after)) throw new Error("dataset source changed while it was being read");
		if (totalBytes === 0) throw new Error("dataset source is empty");
		return Buffer.concat(chunks, totalBytes);
	} finally {
		closeSync(descriptor);
	}
}

/** Read one bounded inbox file from a stable inode and hash exactly those bytes. */
export function readDatasetSource(options: ReadDatasetSourceOptions): DatasetSourceFile {
	const source = resolveSource(options);
	const bytes = readBounded(source.absolute, source.expected);
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw new Error("dataset source is not valid UTF-8", { cause: error });
	}
	const extension = extensionOf(source.relative);
	if (!extension) throw new Error("dataset source has no recognized extension");
	return {
		path: source.relative,
		extension,
		text,
		bytes: bytes.length,
		sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
	};
}
