import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";

const DEFAULT_JSONL_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_JSONL_MAX_RECORDS = 100_000;
const DEFAULT_JSON_MAX_BYTES = 16 * 1024 * 1024;

export class ArtifactError extends Error {
	readonly artifactPath: string;

	constructor(artifactPath: string, message: string, options?: ErrorOptions) {
		super(`artifact ${JSON.stringify(artifactPath)}: ${message}`, options);
		this.name = "ArtifactError";
		this.artifactPath = artifactPath;
	}
}

export interface WriteJsonArtifactOptions {
	/** Publish only when the destination does not already exist. */
	immutable?: boolean;
}

export interface WriteTextArtifactOptions extends WriteJsonArtifactOptions {
	/** Published file mode. Defaults to owner-only evidence. */
	mode?: number;
}

export interface ReadJsonlArtifactOptions {
	/** Hard cap checked while reading, before parsing. */
	maxBytes?: number;
	/** Maximum number of non-blank JSONL records. */
	maxRecords?: number;
}

export interface ReadJsonArtifactOptions {
	/** Hard cap checked while reading, before parsing. */
	maxBytes?: number;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function issuePath(path: PropertyKey[]): string {
	let rendered = "$";
	for (const segment of path) {
		if (typeof segment === "number") {
			rendered += `[${segment}]`;
		} else if (typeof segment === "string" && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
			rendered += `.${segment}`;
		} else {
			rendered += `[${JSON.stringify(String(segment))}]`;
		}
	}
	return rendered;
}

function validationMessage(error: z.ZodError): string {
	return error.issues.map((issue) => `${issuePath(issue.path)}: ${issue.message}`).join("; ");
}

function encodeArtifact<TCodec extends z.ZodType>(
	artifactPath: string,
	codec: TCodec,
	value: z.output<TCodec>,
): z.input<TCodec> {
	let result: z.ZodSafeParseResult<z.input<TCodec>>;
	try {
		result = z.safeEncode(codec, value);
	} catch (error) {
		throw new ArtifactError(artifactPath, `codec encode failed: ${errorMessage(error)}`, { cause: error });
	}
	if (!result.success) {
		throw new ArtifactError(artifactPath, `schema validation failed while encoding: ${validationMessage(result.error)}`);
	}
	return result.data;
}

function decodeArtifact<TCodec extends z.ZodType>(
	artifactPath: string,
	codec: TCodec,
	value: unknown,
	context = "schema validation failed",
): z.output<TCodec> {
	let result: z.ZodSafeParseResult<z.output<TCodec>>;
	try {
		// JSON enters as unknown; the codec is the runtime proof of its input type.
		result = z.safeDecode(codec, value as z.input<TCodec>);
	} catch (error) {
		throw new ArtifactError(artifactPath, `codec decode failed: ${errorMessage(error)}`, { cause: error });
	}
	if (!result.success) {
		throw new ArtifactError(artifactPath, `${context}: ${validationMessage(result.error)}`);
	}
	return result.data;
}

function serializeJson(artifactPath: string, value: unknown): string {
	try {
		const serialized = JSON.stringify(value, null, "\t");
		if (serialized === undefined) {
			throw new TypeError("codec produced a value that JSON cannot represent");
		}
		return `${serialized}\n`;
	} catch (error) {
		throw new ArtifactError(artifactPath, `JSON serialization failed: ${errorMessage(error)}`, { cause: error });
	}
}

function removeTempFile(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if (!isNodeError(error, "ENOENT")) throw error;
	}
}

/**
 * Atomically publish a text artifact. Ordinary writes use a
 * same-directory temporary file followed by rename. Immutable writes publish
 * the same temporary inode with an atomic link, which cannot replace a
 * concurrently-created destination.
 */
export function writeTextArtifact(
	path: string,
	content: string,
	options: WriteTextArtifactOptions = {},
): void {
	const artifactPath = resolve(path);
	const parentDir = dirname(artifactPath);
	if (options.immutable && existsSync(artifactPath)) {
		throw new ArtifactError(artifactPath, "immutable write refused because the destination already exists");
	}

	mkdirSync(parentDir, { recursive: true });
	const tempPath = join(parentDir, `.${basename(artifactPath)}.${process.pid}.${randomUUID()}.tmp`);
	let tempExists = false;

	try {
		const descriptor = openSync(tempPath, "wx", options.mode ?? 0o600);
		tempExists = true;
		try {
			writeFileSync(descriptor, content, "utf8");
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}

		if (options.immutable) {
			try {
				linkSync(tempPath, artifactPath);
			} catch (error) {
				if (isNodeError(error, "EEXIST")) {
					throw new ArtifactError(
						artifactPath,
						"immutable write refused because the destination already exists",
						{ cause: error },
					);
				}
				throw error;
			}
			removeTempFile(tempPath);
			tempExists = false;
		} else {
			renameSync(tempPath, artifactPath);
			tempExists = false;
		}
	} catch (error) {
		if (tempExists) {
			try {
				removeTempFile(tempPath);
			} catch {
				// Preserve the publication error; the uniquely-named temp is recoverable.
			}
		}
		if (error instanceof ArtifactError) throw error;
		throw new ArtifactError(artifactPath, `atomic write failed: ${errorMessage(error)}`, { cause: error });
	}
}

/** Validate with a codec, serialize, then atomically publish JSON. */
export function writeJsonArtifact<TCodec extends z.ZodType>(
	path: string,
	codec: TCodec,
	value: z.output<TCodec>,
	options: WriteJsonArtifactOptions = {},
): void {
	const artifactPath = resolve(path);
	const encoded = encodeArtifact(artifactPath, codec, value);
	writeTextArtifact(artifactPath, serializeJson(artifactPath, encoded), options);
}

function decodeUtf8(artifactPath: string, bytes: Uint8Array, format: "JSON" | "JSONL"): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw new ArtifactError(artifactPath, `${format} is not valid UTF-8`, { cause: error });
	}
}

function readBounded(artifactPath: string, maxBytes: number, format: "JSON" | "JSONL"): Uint8Array {
	let entry;
	try {
		entry = lstatSync(artifactPath);
	} catch (error) {
		throw new ArtifactError(artifactPath, `read failed: ${errorMessage(error)}`, { cause: error });
	}
	if (entry.isSymbolicLink() || !entry.isFile()) {
		throw new ArtifactError(artifactPath, `${format} must be a regular non-symlink file`);
	}
	if (entry.size > maxBytes) {
		throw new ArtifactError(artifactPath, `${format} exceeds maxBytes=${maxBytes}`);
	}

	let descriptor: number;
	try {
		descriptor = openSync(artifactPath, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		throw new ArtifactError(artifactPath, `read failed: ${errorMessage(error)}`, { cause: error });
	}

	try {
		if (!fstatSync(descriptor).isFile()) {
			throw new ArtifactError(artifactPath, `${format} must be a regular non-symlink file`);
		}
		const chunks: Buffer[] = [];
		let totalBytes = 0;
		while (totalBytes <= maxBytes) {
			const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - totalBytes));
			const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
			if (bytesRead === 0) break;
			chunks.push(chunk.subarray(0, bytesRead));
			totalBytes += bytesRead;
		}
		if (totalBytes > maxBytes) {
			throw new ArtifactError(artifactPath, `${format} exceeds maxBytes=${maxBytes}`);
		}
		return Buffer.concat(chunks, totalBytes);
	} catch (error) {
		if (error instanceof ArtifactError) throw error;
		throw new ArtifactError(artifactPath, `read failed: ${errorMessage(error)}`, { cause: error });
	} finally {
		closeSync(descriptor);
	}
}

/** Read bounded JSON and reject non-files, malformed input, or values outside the supplied codec. */
export function readJsonArtifact<TCodec extends z.ZodType>(
	path: string,
	codec: TCodec,
	options: ReadJsonArtifactOptions = {},
): z.output<TCodec> {
	const artifactPath = resolve(path);
	const maxBytes = options.maxBytes ?? DEFAULT_JSON_MAX_BYTES;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		throw new ArtifactError(artifactPath, `maxBytes must be a positive safe integer, got ${maxBytes}`);
	}
	const content = decodeUtf8(artifactPath, readBounded(artifactPath, maxBytes, "JSON"), "JSON");
	let parsed: unknown;
	try {
		parsed = JSON.parse(content) as unknown;
	} catch (error) {
		throw new ArtifactError(artifactPath, `invalid JSON: ${errorMessage(error)}`, { cause: error });
	}
	return decodeArtifact(artifactPath, codec, parsed);
}

/**
 * Read a bounded JSONL artifact. Blank lines are ignored; every non-blank line
 * must be valid JSON and satisfy the codec, otherwise the physical line number
 * is reported.
 */
export function readJsonlArtifact<TCodec extends z.ZodType>(
	path: string,
	codec: TCodec,
	options: ReadJsonlArtifactOptions = {},
): z.output<TCodec>[] {
	const artifactPath = resolve(path);
	const maxBytes = options.maxBytes ?? DEFAULT_JSONL_MAX_BYTES;
	const maxRecords = options.maxRecords ?? DEFAULT_JSONL_MAX_RECORDS;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		throw new ArtifactError(artifactPath, `maxBytes must be a positive safe integer, got ${maxBytes}`);
	}
	if (!Number.isSafeInteger(maxRecords) || maxRecords < 1) {
		throw new ArtifactError(artifactPath, `maxRecords must be a positive safe integer, got ${maxRecords}`);
	}

	const content = decodeUtf8(artifactPath, readBounded(artifactPath, maxBytes, "JSONL"), "JSONL");
	const records: z.output<TCodec>[] = [];
	for (const [index, line] of content.split("\n").entries()) {
		if (!line.trim()) continue;
		const lineNumber = index + 1;
		if (records.length >= maxRecords) {
			throw new ArtifactError(artifactPath, `JSONL exceeds maxRecords=${maxRecords} at line ${lineNumber}`);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch (error) {
			throw new ArtifactError(artifactPath, `invalid JSONL at line ${lineNumber}: ${errorMessage(error)}`, {
				cause: error,
			});
		}
		records.push(decodeArtifact(artifactPath, codec, parsed, `schema validation failed at JSONL line ${lineNumber}`));
	}
	return records;
}
