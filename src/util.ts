import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** The message of whatever was thrown, cut to `maxChars` when a caller bounds it. */
export function errorMessage(error: unknown, maxChars?: number): string {
	const message = error instanceof Error ? error.message : String(error);
	return maxChars === undefined ? message : message.slice(0, maxChars);
}

/** True when `error` is a Node system error carrying this `code` (ENOENT, EEXIST, …). */
export function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

/** A plain object: not null, not an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `bytes` as strict UTF-8; `invalid` builds the caller's own error for a malformed sequence. */
export function decodeUtf8(bytes: Uint8Array, invalid: (cause: unknown) => Error): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw invalid(error);
	}
}

/** `sha256:<hex>` — the one spelling every artifact hash uses. */
export function sha256(content: string | Buffer): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

/** The first executable named `name` on `pathValue`, or `name` itself when absolute. */
export function executableOnPath(name: string, pathValue: string): string | undefined {
	const candidates = isAbsolute(name)
		? [name]
		: pathValue.split(delimiter).filter(Boolean).map((entry) => join(entry, name));
	for (const candidate of candidates) {
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	return undefined;
}

/** A whole-file replacement as one unified-diff hunk. */
export function wholeFileDiff(path: string, before: string, after: string): string {
	const oldLines = before.replace(/\n$/, "").split("\n");
	const newLines = after.replace(/\n$/, "").split("\n");
	return [
		`diff --git a/${path} b/${path}`,
		`--- a/${path}`,
		`+++ b/${path}`,
		`@@ -1,${oldLines.length} +1,${newLines.length} @@`,
		...oldLines.map((line) => `-${line}`),
		...newLines.map((line) => `+${line}`),
	].join("\n");
}
