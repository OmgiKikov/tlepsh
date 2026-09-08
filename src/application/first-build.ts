import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { declaredHarnessRoots, matchesHarnessGlob } from "../domain/harness-surface.js";
import { git, gitEnvironment, gitFailure, gitText } from "../git/commands.js";
import type { ResolvedTarget } from "../manifest.js";
import { sha256 } from "../util.js";
import { namedDirtyPaths, operatorDirtyPaths } from "./store-hygiene.js";
import { templateInventory } from "./target-scaffold.js";

/**
 * The first build of an agent.
 *
 * A scaffolded Target is starting material: its instructions are the packaged
 * template's, byte for byte. Nothing about it has been measured and there is
 * nothing to regress, so the first reviewed build lands straight on the
 * operator's branch — the same one-time host-confirmed bootstrap that choosing
 * the model is (invariant 18) — and the candidate ritual (a matched
 * verification, a sealed exam) starts with the first change to an agent that
 * exists. Before this, a new agent was measured as a template, "improved" into
 * existence, and verified against the template it replaced.
 *
 * "Still the template" is a fact the host reads off the disk, never a claim a
 * model makes: every instruction file the Target declares is byte-identical to
 * a file of the same path in one of the packaged templates.
 */

const TEMPLATES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");
/** A hand-written instruction file is small; anything larger is not a template. */
const MAX_INSTRUCTION_BYTES = 1024 * 1024;
const MAX_INSTRUCTION_FILES = 200;
const MAX_INSTRUCTION_DEPTH = 6;

let packaged: Map<string, Set<string>> | null = null;

/** Every packaged template file, keyed by its relative path, with every hash it ships under. */
function packagedTemplateHashes(): Map<string, Set<string>> {
	if (packaged) return packaged;
	const hashes = new Map<string, Set<string>>();
	for (const entry of readdirSync(TEMPLATES_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const directory = join(TEMPLATES_DIR, entry.name);
		if (!existsSync(join(directory, "manifest.yaml"))) continue;
		for (const file of templateInventory(directory)) {
			const known = hashes.get(file.path) ?? new Set<string>();
			known.add(file.sha256);
			hashes.set(file.path, known);
		}
	}
	packaged = hashes;
	return hashes;
}

/**
 * The files that say what the agent does: its instructions file, plus every
 * file of the surface `harness.files` declares (a command Target's prompts).
 * Skills and tools are not counted — a template ships example tools, and an
 * agent is written in its instructions first.
 */
export function instructionFiles(target: Pick<ResolvedTarget, "dir" | "manifest">): string[] {
	const files = new Set<string>([target.manifest.instructions.agentsMd]);
	const declared = target.manifest.harness?.files;
	if (declared) {
		let scanned = 0;
		const walk = (relative: string, depth: number): void => {
			if (depth > MAX_INSTRUCTION_DEPTH || scanned >= MAX_INSTRUCTION_FILES) return;
			let names: string[];
			try {
				names = readdirSync(join(target.dir, relative)).sort();
			} catch {
				return;
			}
			for (const name of names) {
				const path = relative ? `${relative}/${name}` : name;
				let entry;
				try {
					entry = lstatSync(join(target.dir, path));
				} catch {
					continue;
				}
				if (entry.isSymbolicLink()) continue;
				if (entry.isDirectory()) walk(path, depth + 1);
				else if (entry.isFile() && declared.some((glob) => matchesHarnessGlob(path, glob))) {
					scanned += 1;
					files.add(path);
				}
			}
		};
		for (const root of declaredHarnessRoots(declared)) walk(root, 0);
	}
	return [...files].sort();
}

/**
 * Whether somebody has written this agent yet.
 *
 * False while every instruction file on disk is one a packaged template ships
 * under the same path; true the moment one of them differs. An adopted folder
 * is built by definition — its prompts are the operator's — and so is a
 * scaffold whose instructions were edited by hand before the first `ahde`.
 */
export function isTargetBuilt(target: Pick<ResolvedTarget, "dir" | "manifest">): boolean {
	let hashes: Map<string, Set<string>>;
	try {
		hashes = packagedTemplateHashes();
	} catch {
		// Without the packaged templates nothing can be called a template.
		return true;
	}
	for (const path of instructionFiles(target)) {
		let entry;
		try {
			entry = lstatSync(join(target.dir, path));
		} catch {
			continue;
		}
		if (!entry.isFile() || entry.isSymbolicLink()) continue;
		if (entry.size > MAX_INSTRUCTION_BYTES) return true;
		let content: Buffer;
		try {
			content = readFileSync(join(target.dir, path));
		} catch {
			continue;
		}
		if (!hashes.get(path)?.has(sha256(content))) return true;
	}
	return false;
}

export interface FirstBuildLanding {
	/** The operator's branch, the one that moved. */
	branch: string;
	fromSha: string;
	toSha: string;
	disposition: "landed" | "already-landed";
}

/**
 * Fast-forward the operator's branch onto the built revision the apply just
 * committed. Idempotent: a retry after a crash between the apply receipt and
 * this step finds the branch either still at the base (and moves it) or already
 * at the build (and records that). Anything else is a different history and is
 * refused by name.
 */
export function landFirstBuild(options: { repositoryDir: string; baseSha: string; builtSha: string }): FirstBuildLanding {
	const dir = options.repositoryDir;
	const dirty = operatorDirtyPaths(
		git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { env: gitEnvironment() }).toString("utf8"),
	);
	if (dirty.length > 0) {
		throw new Error(`the first build cannot land while the Target has uncommitted changes (${namedDirtyPaths(dirty)}); commit them first`);
	}
	let ref: string;
	try {
		ref = gitText(dir, ["symbolic-ref", "-q", "HEAD"], { env: gitEnvironment() });
	} catch (error) {
		throw new Error("the first build lands on a named branch; the Target is on a detached HEAD", { cause: error });
	}
	if (!ref.startsWith("refs/heads/")) throw new Error(`the first build lands on a named branch; HEAD is ${ref}`);
	const branch = ref.slice("refs/heads/".length);
	const head = gitText(dir, ["rev-parse", "--verify", "HEAD^{commit}"], { env: gitEnvironment() });
	if (head === options.builtSha) return { branch, fromSha: options.baseSha, toSha: head, disposition: "already-landed" };
	if (head !== options.baseSha) {
		throw new Error(
			`the first build was written against ${options.baseSha.slice(0, 10)} but ${branch} is at ${head.slice(0, 10)}; ` +
			"the agent moved on since — discard this build and open a new workshop on the current revision",
		);
	}
	const args = ["-c", "core.hooksPath=/dev/null", "merge", "--ff-only", "--no-edit", "--no-stat", options.builtSha];
	try {
		git(dir, args, { env: gitEnvironment() });
	} catch (error) {
		throw gitFailure(args, error);
	}
	const after = gitText(dir, ["rev-parse", "--verify", "HEAD^{commit}"], { env: gitEnvironment() });
	if (after !== options.builtSha) throw new Error("the first build did not land on the exact built revision");
	return { branch, fromSha: options.baseSha, toSha: after, disposition: "landed" };
}

/** Whether a first build's revision is on the operator's branch: HEAD, or behind it. */
export function firstBuildLanded(repositoryDir: string, builtSha: string): boolean {
	const result = spawnSync("git", ["--no-replace-objects", "-C", repositoryDir, "merge-base", "--is-ancestor", builtSha, "HEAD"], {
		stdio: "ignore",
		env: gitEnvironment(),
	});
	return result.status === 0;
}
