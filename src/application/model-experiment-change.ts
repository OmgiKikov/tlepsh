import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { loadCorpus } from "../corpus.js";
import { hashFile, hashValue } from "../provenance.js";
import { writeJsonArtifact } from "../storage/artifacts.js";
import { loadModelExperiment, modelExperimentDirectory, type ModelExperimentReadScope } from "./model-experiment.js";
import { cleanModelExperimentSource, modelExperimentGit as git, modelOnlyManifest } from "./model-experiment-source.js";
import { ModelChangeReceiptSchema, ModelChangeSubjectSchema, type ModelChangeReceipt, type ModelChangeSubject } from "./model-experiment-types.js";
import { fastForwardReviewedModel } from "./model-experiment-ref-guard.js";

export interface DescribeModelChangeOptions extends ModelExperimentReadScope { targetDir: string; runsRoot: string; experimentId: string; armId: string }

function manifestDiff(before: string, after: string): string {
	const root = mkdtempSync(join(tmpdir(), "ahde-model-diff-"));
	try {
		writeFileSync(join(root, "before"), before);
		writeFileSync(join(root, "after"), after);
		const diff = spawnSync("git", ["diff", "--no-ext-diff", "--text", "--no-index", "--", "before", "after"], { cwd: root, encoding: "utf8", maxBuffer: 3 * 1024 * 1024 });
		if (diff.status !== 1) throw new Error("cannot prepare an exact nonempty model diff");
		const hunk = diff.stdout.indexOf("@@");
		if (hunk < 0) throw new Error("model diff contains no textual hunk");
		return `--- manifest.yaml (current)\n+++ manifest.yaml (selected model)\n${diff.stdout.slice(hunk)}`;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

export function describeModelChange(options: DescribeModelChangeOptions): ModelChangeSubject {
	const source = cleanModelExperimentSource(options.targetDir);
	const experiment = loadModelExperiment(options.runsRoot, options.experimentId, { ...options, targetDir: source.dir });
	if (loadCorpus(experiment.plan.corpus).metadata.hash !== experiment.plan.corpusHash) throw new Error("experiment corpus changed since measurement");
	const arm = experiment.arms.find((item) => item.armId === options.armId);
	if (!arm || arm.armId === "baseline" || arm.status !== "completed" || arm.meanScore === null || arm.quality === null) throw new Error("model change requires a complete measured alternative");
	if (source.baseSha !== experiment.plan.baseSha || source.headRef !== experiment.plan.headRef || source.manifestHash !== experiment.plan.manifestHash) throw new Error("Target changed since this model experiment; run a fresh experiment");
	const after = modelOnlyManifest(source.manifestText, arm.model);
	const identity = {
		schemaVersion: 1 as const, experimentId: experiment.id, armId: arm.armId,
		experimentHash: hashValue(experiment), targetDir: source.dir, baseSha: source.baseSha, headRef: source.headRef,
		manifestPath: "manifest.yaml" as const, beforeManifestHash: source.manifestHash, afterManifestHash: hashFile(after),
		previousModel: source.target.manifest.model, nextModel: arm.model,
		diff: manifestDiff(source.manifestText, after),
	};
	return ModelChangeSubjectSchema.parse({ ...identity, subjectHash: hashValue(identity) });
}

export interface ApplyModelChangeOptions extends ModelExperimentReadScope {
	targetDir: string; runsRoot: string; subject: ModelChangeSubject; expectedSubjectHash: string; actorId: string; reason: string;
}

/** Human-confirmed working configuration only. No candidate, promotion, release ref or rollback claim. */
export function applyModelChange(options: ApplyModelChangeOptions): ModelChangeReceipt {
	const accepted = ModelChangeSubjectSchema.parse(options.subject);
	const actorId = z.string().trim().min(1).max(256).parse(options.actorId);
	const reason = z.string().trim().min(1).max(4000).parse(options.reason);
	const directory = modelExperimentDirectory(options.runsRoot, accepted.experimentId);
	const path = join(directory, `model-change-${accepted.armId}.json`);
	if (existsSync(path)) throw new Error("this model change was already applied; confirmation cannot be replayed");
	const lockPath = join(directory, ".model-change.lock");
	const lock = openSync(lockPath, "wx", 0o600);
	let temporary: string | null = null;
	try {
		const subject = describeModelChange({ ...options, experimentId: accepted.experimentId, armId: accepted.armId });
		if (subject.subjectHash !== options.expectedSubjectHash || hashValue(subject) !== hashValue(accepted)) throw new Error("model change confirmation is stale");
		const before = readFileSync(join(subject.targetDir, "manifest.yaml"), "utf8");
		const after = modelOnlyManifest(before, subject.nextModel);
		if (hashFile(after) !== subject.afterManifestHash) throw new Error("model change bytes differ from the reviewed diff");
		temporary = mkdtempSync(join(tmpdir(), "ahde-model-change-"));
		const index = join(temporary, "index");
		const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: "AHDE Model Selection", GIT_AUTHOR_EMAIL: "model-selection@ahde.local", GIT_COMMITTER_NAME: "AHDE Model Selection", GIT_COMMITTER_EMAIL: "model-selection@ahde.local" };
		git(subject.targetDir, ["read-tree", subject.baseSha], undefined, env);
		const blob = git(subject.targetDir, ["hash-object", "-w", "--stdin"], after);
		const mode = git(subject.targetDir, ["ls-tree", subject.baseSha, "--", "manifest.yaml"]).split(" ")[0];
		if (mode !== "100644" && mode !== "100755") throw new Error("manifest is not a tracked regular file");
		git(subject.targetDir, ["update-index", "--add", "--cacheinfo", `${mode},${blob},manifest.yaml`], undefined, env);
		const tree = git(subject.targetDir, ["write-tree"], undefined, env);
		const revision = git(subject.targetDir, ["commit-tree", tree, "-p", subject.baseSha, "-m", `Select ${subject.nextModel.provider}/${subject.nextModel.id} after model experiment`], undefined, env);
		if (git(subject.targetDir, ["diff-tree", "--no-commit-id", "--name-only", "-r", revision]) !== "manifest.yaml") throw new Error("model selection commit contains unexpected files");
		const receipt = ModelChangeReceiptSchema.parse({ schemaVersion: 1, id: `model-change-${subject.subjectHash.slice(7)}`, subject,
			configuredTargetSha: revision, actorId, reason, configuredAt: new Date().toISOString() });
		// A durable intent precedes the ref update. A crash may have moved HEAD;
		// the pending receipt names that exact commit instead of pretending rollback.
		writeJsonArtifact(join(directory, `model-change-${accepted.armId}.pending.json`), ModelChangeReceiptSchema, receipt, { immutable: true });
		const fresh = cleanModelExperimentSource(subject.targetDir);
		if (fresh.baseSha !== subject.baseSha || fresh.headRef !== subject.headRef || fresh.manifestHash !== subject.beforeManifestHash) throw new Error("Target changed while preparing the exact model change");
		const hooks = join(temporary, "hooks");
		mkdirSync(hooks);
		fastForwardReviewedModel({ targetDir: subject.targetDir, hooksPath: hooks, headRef: subject.headRef, baseSha: subject.baseSha, revision });
		const applied = cleanModelExperimentSource(subject.targetDir);
		if (applied.headRef !== subject.headRef || applied.baseSha !== revision || applied.manifestHash !== subject.afterManifestHash) throw new Error(`model change committed ${revision}, but checkout changed concurrently; inspect the durable pending receipt`);
		writeJsonArtifact(path, ModelChangeReceiptSchema, receipt, { immutable: true });
		unlinkSync(join(directory, `model-change-${accepted.armId}.pending.json`));
		return receipt;
	} finally {
		if (temporary !== null) rmSync(temporary, { recursive: true, force: true });
		closeSync(lock);
		unlinkSync(lockPath);
	}
}
