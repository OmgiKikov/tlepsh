import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseDocument, parse } from "yaml";
import { loadTarget, TargetManifest, type ResolvedTarget } from "../manifest.js";
import { hashValue, hashFile } from "../provenance.js";

export function modelExperimentGit(dir: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): string {
	return execFileSync("git", ["-C", dir, ...args], {
		encoding: "utf8", stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		maxBuffer: 16 * 1024 * 1024, ...(input === undefined ? {} : { input }), ...(env ? { env } : {}),
	}).trim();
}

/** Stable before mkdir and after it, including paths beneath a symlinked /tmp. */
export function canonicalModelExperimentStore(input: string): string {
	let ancestor = resolve(input);
	const suffix: string[] = [];
	while (!existsSync(ancestor)) {
		suffix.unshift(basename(ancestor));
		ancestor = dirname(ancestor);
	}
	return join(realpathSync(ancestor), ...suffix);
}

export function cleanModelExperimentSource(targetDir: string) {
	const dir = realpathSync(targetDir);
	if (realpathSync(modelExperimentGit(dir, ["rev-parse", "--show-toplevel"])) !== dir) throw new Error("model experiment requires a Target repository root");
	const headRef = modelExperimentGit(dir, ["symbolic-ref", "--quiet", "HEAD"]);
	if (!headRef.startsWith("refs/heads/")) throw new Error("model experiment requires a named branch");
	if (modelExperimentGit(dir, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") throw new Error("model experiment requires a clean Target checkout");
	const path = join(dir, "manifest.yaml");
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error("model experiment requires a bounded regular manifest");
	const manifestText = readFileSync(path, "utf8");
	const target = loadTarget(dir);
	if (target.manifest.execution?.kind === "command") throw new Error("model experiments currently require a Pi Target; command Targets cannot attest which model actually ran");
	return { dir, headRef, baseSha: modelExperimentGit(dir, ["rev-parse", "HEAD"]), manifestText, manifestHash: hashFile(manifestText), target };
}

export function modelExperimentHarnessHash(target: ResolvedTarget): string {
	return hashValue({ manifest: { ...target.manifest, model: null }, runtime: target.runtime, toolsetHash: target.toolsetHash });
}

export function modelOnlyManifest(text: string, model: ResolvedTarget["manifest"]["model"]): string {
	const before = TargetManifest.parse(parse(text));
	const document = parseDocument(text);
	if (document.errors.length > 0) throw new Error("manifest YAML cannot be edited safely");
	document.set("model", model);
	const output = document.toString();
	const after = TargetManifest.parse(parse(output));
	if (hashValue({ ...before, model: null }) !== hashValue({ ...after, model: null }) || hashValue(after.model) !== hashValue(model)) {
		throw new Error("model experiment changed fields outside the model block");
	}
	return output;
}
