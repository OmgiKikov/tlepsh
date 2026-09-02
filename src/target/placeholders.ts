import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { plural, t } from "../i18n.js";

/**
 * Template stand-ins: the text a template leaves behind for the operator to
 * replace.
 *
 * A template is starting material, not a configuration. Everything it cannot
 * know — the agent's name, its model, what it is for, what its tool returns —
 * is written as `REPLACE-ME`, and the whole product promise is that the
 * conversation replaces those, never the operator in an editor. So the harness
 * has to be able to SEE one: a stand-in model is not a model, a stand-in judge
 * is not a judge, and a file still full of `REPLACE-ME` is not an agent
 * description worth measuring.
 *
 * `REPLACE_ME` is the same marker where a `-` would be illegal (environment
 * variable names), and the match is case-insensitive because a target id may
 * only be lowercase.
 */
const STAND_IN = /replace[-_]me/i;

/** Whether any part of this text is still a template stand-in. */
export function isStandIn(text: string): boolean {
	return STAND_IN.test(text);
}

/** Whether a model block names a stand-in provider, model or endpoint. */
export function isStandInModel(model: { provider: string; id: string; baseUrl: string }): boolean {
	return isStandIn(model.provider) || isStandIn(model.id) || isStandIn(model.baseUrl);
}

/**
 * Which identity fields of a manifest are still stand-ins, named exactly as the
 * manifest names them so the blocker can say which ones without the operator
 * having to open the file to find out.
 */
export function standInManifestFields(
	manifest: { id: string; model: { provider: string; id: string; baseUrl: string; apiKeyEnv: string } },
): string[] {
	const fields: string[] = [];
	if (isStandIn(manifest.id)) fields.push("id");
	for (const key of ["provider", "id", "baseUrl", "apiKeyEnv"] as const) {
		if (isStandIn(manifest.model[key])) fields.push(`model.${key}`);
	}
	return fields;
}

/** A file over this size is not a hand-written instruction file; it is data. */
const MAX_STAND_IN_BYTES = 1024 * 1024;
/** The line names files; past this many it would stop being one line. */
export const MAX_STAND_IN_FILES = 20;
/** A readiness check reads a harness, never an arbitrary tree. */
const MAX_SCANNED_FILES = 500;
const MAX_SCAN_DEPTH = 4;

/** Root files that carry prose the Builder rewrites. */
const ROOT_FILES = ["AGENTS.md", "spec.md"] as const;

/**
 * Directories worth reading, and what counts inside them. `evals/` holds the
 * cases and their grader defaults; everything else under it is evidence.
 */
const SCANNED_DIRECTORIES: readonly { path: string; keep: (name: string) => boolean }[] = [
	{ path: "bin", keep: () => true },
	{ path: "evals", keep: (name) => name.endsWith(".jsonl") || name === "graders.yaml" },
	{ path: "skills", keep: () => true },
	{ path: "tools", keep: () => true },
];

/**
 * Every file under the Target that still carries the template's stand-ins, in a
 * stable order: the root files first, then each scanned directory. Bounded in
 * file size, file count and depth — this runs on a readiness check, not on a
 * corpus. Unreadable entries are simply not reported.
 */
export function standInTargetFiles(targetDir: string): string[] {
	const root = resolve(targetDir);
	const found: string[] = [];
	let scanned = 0;

	const consider = (relativePath: string): void => {
		if (found.length >= MAX_STAND_IN_FILES || scanned >= MAX_SCANNED_FILES) return;
		const path = join(root, relativePath);
		let entry;
		try {
			entry = lstatSync(path);
		} catch {
			return;
		}
		if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_STAND_IN_BYTES) return;
		scanned += 1;
		let content: string;
		try {
			content = readFileSync(path, "utf8");
		} catch {
			return;
		}
		if (isStandIn(content)) found.push(relativePath);
	};

	const walk = (relativeDir: string, keep: (name: string) => boolean, depth: number): void => {
		if (depth > MAX_SCAN_DEPTH || found.length >= MAX_STAND_IN_FILES || scanned >= MAX_SCANNED_FILES) return;
		let names: string[];
		try {
			names = readdirSync(join(root, relativeDir)).sort();
		} catch {
			return;
		}
		for (const name of names) {
			const relativePath = `${relativeDir}/${name}`;
			let entry;
			try {
				entry = lstatSync(join(root, relativePath));
			} catch {
				continue;
			}
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) walk(relativePath, keep, depth + 1);
			else if (keep(name)) consider(relativePath);
		}
	};

	for (const name of [...ROOT_FILES].sort()) consider(name);
	for (const directory of SCANNED_DIRECTORIES) walk(directory.path, directory.keep, 0);
	return found;
}

/**
 * The one readiness line every surface says about stand-in text — `ahde
 * validate`, `/doctor`, and the Builder's own view. Never a blocker: describing
 * the agent is exactly how these files get replaced, so the operator can walk
 * straight past it into the conversation. Null when the harness is clean.
 */
export function standInFilesLine(targetDir: string): string | null {
	const files = standInTargetFiles(targetDir);
	if (files.length === 0) return null;
	return t("readiness.stand-ins", { files: plural(files.length, "file"), names: files.join(", ") });
}
