/** Resolve provenance inside the current stores without changing the recorded identity. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, isAbsolute, posix, relative as relativePath, resolve, sep, win32 } from "node:path";
import type { CandidateArtifactRef, CandidateRecord } from "../domain/candidate.js";
import { resolveContainedArtifactPath, safeArtifactSegment } from "../storage/paths.js";

export type AppliedCandidateOrigin = Extract<CandidateRecord["origin"], { kind: "applied-builder" }>;
export type CandidateArtifactKind = "builderRun" | "builderInput" | "proposal" | "applyReceipt" |
	"sourceEval" | "sourceDiagnosis" | "approvedSpec" | "experimentDesign";
const LABELS: Record<CandidateArtifactKind, string> = {
	builderRun: "Builder run", builderInput: "Builder input", proposal: "Builder proposal",
	applyReceipt: "Builder apply receipt", sourceEval: "Builder source eval", sourceDiagnosis: "Builder diagnosis",
	approvedSpec: "approved Spec", experimentDesign: "blind experiment design",
};
const MAX_BYTES = 16 * 1024 * 1024;
const BUILDER_FILES = { builderRun: "builder_run.json", builderInput: "builder_input.txt", proposal: "proposal.json", applyReceipt: "apply_receipt.json" } as const;

function hint(path: string): { text: string; absolute: boolean } {
	const absolute = isAbsolute(path) || win32.isAbsolute(path);
	const text = win32.isAbsolute(path) ? path.replaceAll("\\", "/") : path;
	if (text.includes("\\") || text.includes("\0") || text.split("/").some((part) => part === "." || part === "..")) {
		throw new Error("candidate provenance path contains traversal or an invalid separator");
	}
	return { text, absolute };
}

/** Legacy prefixes are never opened, even when the old copy still exists. */
function matches(ref: CandidateArtifactRef, expected: string): void {
	const value = hint(ref.path);
	if (value.absolute ? !value.text.endsWith(`/${expected}`) : value.text !== expected) {
		throw new Error("candidate provenance points at an unexpected artifact path");
	}
}

export function candidateArtifactReference(origin: AppliedCandidateOrigin, kind: CandidateArtifactKind): CandidateArtifactRef {
	if (kind === "approvedSpec") return origin.approvedSpec.artifact;
	if (kind === "sourceEval" || kind === "sourceDiagnosis") {
		if (!origin.source) throw new Error("candidate has no source evidence");
		return kind === "sourceEval" ? origin.source.evalRun : origin.source.diagnosis;
	}
	if (kind === "experimentDesign") {
		if (!origin.experimentDesign) throw new Error("candidate has no blind experiment design");
		return origin.experimentDesign;
	}
	return origin[kind];
}

function ownedPath(root: string, path: string): string {
	const [first, ...rest] = path.split("/");
	return resolveContainedArtifactPath(root, first!, ...rest);
}

function artifactLocation(runsRoot: string, origin: AppliedCandidateOrigin, kind: CandidateArtifactKind, stateRoot?: string): string {
	const builderId = safeArtifactSegment(origin.builderRunId);
	const ref = candidateArtifactReference(origin, kind);
	let relative: string;
	if (kind in BUILDER_FILES) {
		relative = `builders/${builderId}/${BUILDER_FILES[kind as keyof typeof BUILDER_FILES]}`;
	} else if (kind === "sourceEval" || kind === "sourceDiagnosis") {
		relative = `${safeArtifactSegment(origin.source!.evalRunId)}/${kind === "sourceEval" ? "eval_run.json" : "diagnosis.json"}`;
	} else if (kind === "experimentDesign") {
		const match = /(?:^|\/)improvement-designs\/(loop_[a-z0-9]{6,32})\.json$/.exec(hint(ref.path).text);
		if (!match) throw new Error("candidate provenance has an invalid blind experiment path");
		relative = `improvement-designs/${match[1]}.json`;
	} else {
		relative = `builders/${builderId}/approved_spec.json`;
		if (hint(ref.path).absolute) {
			// Old records kept their Spec in a separately configured state store.
			const suffix = `projects/${safeArtifactSegment(origin.approvedSpec.projectId)}/specs/${safeArtifactSegment(origin.approvedSpec.specId)}.json`;
			matches(ref, suffix);
			if (stateRoot) return ownedPath(stateRoot, suffix);
			const builderSuffix = `builders/${builderId}/builder_run.json`;
			matches(origin.builderRun, builderSuffix);
			const oldBuilder = hint(origin.builderRun.path);
			if (!oldBuilder.absolute) throw new Error("legacy candidate Spec requires an explicit stateRoot");
			const oldRuns = oldBuilder.text.slice(0, -builderSuffix.length - 1);
			const oldState = hint(ref.path).text.slice(0, -suffix.length - 1);
			// Historical macOS writers mixed canonical /private paths with
			// caller /var or /tmp spellings. Normalize these known layout
			// spellings lexically, including when read on another OS.
			const layoutPath = (path: string) => path.replace(/^\/private\/(var|tmp)(?=\/|$)/, "/$1");
			const layout = posix.relative(layoutPath(oldRuns), layoutPath(oldState));
			// Infer only the ordinary sibling-store layout. No ancestor walking,
			// filesystem discovery or fallback to the former absolute location.
			if (!/^\.\.\/[A-Za-z0-9._-]+$/.test(layout)) {
				throw new Error("legacy candidate Spec requires an explicit stateRoot for this store layout");
			}
			return ownedPath(resolve(dirname(resolve(runsRoot)), layout.slice(3)), suffix);
		}
	}
	matches(ref, relative);
	return ownedPath(runsRoot, relative);
}

function readBounded(path: string): Buffer {
	const entry = lstatSync(path);
	if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_BYTES) {
		throw new Error("candidate provenance artifact is not a bounded regular non-symlink file");
	}
	// O_NONBLOCK avoids waiting on a FIFO substituted between lstat and open;
	// fstat still verifies the opened descriptor before reading any bytes.
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("candidate provenance artifact is not a bounded regular file");
		const chunks: Buffer[] = [];
		let total = 0;
		while (total <= MAX_BYTES) {
			const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_BYTES + 1 - total));
			const count = readSync(fd, chunk);
			if (count === 0) return Buffer.concat(chunks, total);
			chunks.push(chunk.subarray(0, count)); total += count;
		}
		throw new Error("candidate provenance artifact exceeds the verification limit");
	} finally { closeSync(fd); }
}

export function readCandidateArtifact(
	runsRoot: string, origin: AppliedCandidateOrigin, kind: CandidateArtifactKind,
	options: { stateRoot?: string; expectedHash?: string } = {},
): { path: string; bytes: Buffer } {
	const path = artifactLocation(runsRoot, origin, kind, options.stateRoot);
	const bytes = readBounded(path);
	const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
	if (actual !== candidateArtifactReference(origin, kind).sha256 || (options.expectedHash !== undefined && actual !== options.expectedHash)) {
		throw new Error(`${LABELS[kind]} changed after the candidate was created: ${LABELS[kind]} hash mismatch (provenance artifact hash mismatch)`);
	}
	if (kind === "experimentDesign") {
		const design = JSON.parse(bytes.toString("utf8")) as { loopId?: unknown; projectId?: unknown };
		if (typeof design.loopId !== "string" || !/^loop_[a-z0-9]{6,32}$/.test(design.loopId) ||
			design.projectId !== origin.approvedSpec.projectId ||
			path !== resolveContainedArtifactPath(runsRoot, "improvement-designs", `${design.loopId}.json`)) {
			throw new Error("candidate blind experiment design path does not match its identity");
		}
	}
	return { path, bytes };
}

export function resolveCandidateArtifact(
	runsRoot: string, origin: AppliedCandidateOrigin, kind: CandidateArtifactKind,
	options: { stateRoot?: string; expectedHash?: string } = {},
): string {
	return readCandidateArtifact(runsRoot, origin, kind, options).path;
}

/** Writer only: callers supply a path derived inside this configured store. */
export function portableCandidateArtifact(runsRoot: string, path: string): CandidateArtifactRef {
	const root = dirname(resolveContainedArtifactPath(runsRoot, "builders"));
	let relative = relativePath(resolve(runsRoot), resolve(path)).split(sep).join("/");
	if (relative.startsWith("../") || isAbsolute(relative)) relative = relativePath(root, resolve(path)).split(sep).join("/");
	if (relative.startsWith("../") || isAbsolute(relative)) throw new Error("candidate artifact is outside its runs root");
	const bytes = readBounded(ownedPath(runsRoot, relative));
	return { path: relative, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}
