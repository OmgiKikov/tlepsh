import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { hashFile } from "./provenance.js";
import { runTask } from "./runner.js";
import { TargetManifest, type ResolvedTarget } from "./manifest.js";

/**
 * Builder = a Target whose task input is a failure bundle. Runs through the
 * same runner (own model, own trace, own run dir) and must produce a git
 * branch with a non-empty diff in the target repo. Swappable: any agent that
 * satisfies "bundle in → branch out" is a valid builder.
 */

export const BuilderManifest = z.strictObject({
	id: z.string().min(1),
	/**
	 * Frontier model for the builder. Optional: when omitted the builder
	 * inherits the target's model (one-place config for experiments).
	 * Production builders should declare an explicit frontier model.
	 */
	model: TargetManifest.shape.model.optional(),
	instructions: z.strictObject({
		agentsMd: z.string().min(1),
	}),
	skills: z.array(z.string().min(1)).default([]),
});
export type BuilderManifest = z.infer<typeof BuilderManifest>;

export interface BuilderResult {
	/** RunRecord id of the builder's own run (evidence chain). */
	builderRunId: string;
	branch: string;
	commitSha: string;
	changedFiles: string[];
}

function git(targetDir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", targetDir, ...args], { encoding: "utf8" }).trim();
}

function builderTaskInput(bundlePath: string, branch: string): string {
	return [
		"Ты — инженер, улучшающий target-агента. Прочитай failure bundle и улуч target harness.",
		"",
		`1. Прочитай файл ${bundlePath} (инструментом read).`,
		"2. Проанализируй failures и предложи минимальный патч harness-файлов.",
		"3. Создай git-ветку и примени патч:",
		`   git checkout -b ${branch}`,
		"   ... внеси изменения ...",
		'   git add -A && git commit -m "improve: <описание>"',
		"4. НЕ трогай evals/** и model-настройки manifest.yaml (правила scope в bundle).",
		"5. Закончи кратким описанием того, что изменил и почему.",
	].join("\n");
}

/**
 * Run the builder agent against the target repo. The builder session runs
 * with cwd = target repo so its file tools edit the repo directly.
 */
export async function runBuilder(
	builderDir: string,
	target: ResolvedTarget,
	bundlePath: string,
	options: { runsRoot: string; branch?: string },
): Promise<BuilderResult> {
	if (!/^[0-9a-f]{40}$/.test(target.gitSha)) {
		throw new Error("builder requires a committed, clean target repo; commit or stash target changes first");
	}
	const manifestResult = BuilderManifest.safeParse(parseYaml(readFileSync(resolve(builderDir, "manifest.yaml"), "utf8")));
	if (!manifestResult.success) {
		throw new Error(`builder manifest.yaml: ${manifestResult.error.message}`);
	}
	const manifest = manifestResult.data;
	const model = manifest.model ?? target.manifest.model;
	readFileSync(resolve(builderDir, manifest.instructions.agentsMd)); // existence check
	for (const skill of manifest.skills) readFileSync(resolve(builderDir, `${skill}/SKILL.md`));

	const branch = options.branch ?? `candidate-${Date.now().toString(36)}`;
	const bundleContent = readFileSync(bundlePath, "utf8");
	const bundleHash = hashFile(bundleContent);

	// A hybrid ResolvedTarget: builder manifest, target repo as cwd.
	// eval fields carry the bundle hash so builder-run provenance is honest.
	const builderTarget: ResolvedTarget = {
		dir: target.dir,
		manifest: {
			...target.manifest,
			id: `builder:${manifest.id}`,
			model,
			instructions: { agentsMd: resolve(builderDir, manifest.instructions.agentsMd) },
			skills: manifest.skills.map((s) => resolve(builderDir, s)),
			evalSuite: { id: "builder-task", dataset: bundlePath, graders: bundlePath },
		},

		gitSha: target.gitSha,
		runtime: target.runtime,
		tasks: [],
		datasetHash: bundleHash,
		suiteHash: bundleHash,
	};

	const record = await runTask(
		builderTarget,
		{ id: `builder:${branch}`, input: builderTaskInput(bundlePath, branch), effectiveGraders: [] },
		{
			runsRoot: options.runsRoot,
			label: "solo",
			repetitionIndex: 0,
			evalRunId: null,
			candidateOf: null,
			workspaceMode: "direct",
		},
	);

	if (record.status !== "completed") {
		throw new Error(`builder run failed: ${record.error ?? record.status} (see runs/${record.runId})`);
	}

	// Contract verification: branch exists, diff vs baseline is non-empty.
	let branches: string;
	try {
		branches = git(target.dir, "branch", "--list", branch);
	} catch (error) {
		throw new Error(`builder did not create branch "${branch}": ${(error as Error).message} (see runs/${record.runId})`);
	}
	if (!branches.includes(branch)) {
		throw new Error(`builder did not create branch "${branch}" (see runs/${record.runId})`);
	}
	const changed = git(target.dir, "diff", "--name-only", `${target.gitSha}..${branch}`);
	const changedFiles = changed.split("\n").filter(Boolean);
	if (changedFiles.length === 0) {
		throw new Error(`builder branch "${branch}" has an empty diff (see runs/${record.runId})`);
	}
	const commitSha = git(target.dir, "rev-parse", branch);

	return { builderRunId: record.runId, branch, commitSha, changedFiles };
}
