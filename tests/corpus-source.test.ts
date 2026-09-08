import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureCorpusSourceBinding, CorpusSourceBindingSchema } from "../src/application/corpus-source.js";
import {
	BuilderCorpusDraftSchema,
	BuilderCorpusDraftTaskInputSchema,
	BuilderCorpusDraftTaskProvenanceSchema,
	builderCorpusDraftTaskId,
	createBuilderCorpusDraft,
	listBuilderCorpusDrafts,
	loadBuilderCorpusDraft,
	reviseBuilderCorpusDraft,
} from "../src/application/builder-corpus-draft.js";
import * as gitCommands from "../src/git/commands.js";
import { gitText } from "../src/git/commands.js";
import * as manifestModule from "../src/manifest.js";
import { loadTarget, type ResolvedTarget } from "../src/manifest.js";
import { hashValue } from "../src/provenance.js";
import { loadApprovedSpec, saveSpecSnapshot } from "../src/spec.js";
import { WorkbenchSubmitInputSchema } from "../src/workbench/types.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

const roots: string[] = [];
const NOW = "2026-09-07T12:00:00.000Z";
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) cleanup(root);
});

function fixture(data = ["data/kb"]): ResolvedTarget {
	const files = baseFixtureFiles({
		".gitignore": ".ahde/\nruns/\n",
		"data/kb/public/policy.md": "Refunds within 30 days.\n",
		"data/kb/private/internal.bin": "PRIVATE BYTES\0",
		"data/fixtures/account.json": '{"balance": 12}\n',
	});
	files.find((file) => file.path === "manifest.yaml")!.content += `data: ${JSON.stringify(data)}\n`;
	const root = makeTargetFixture(files);
	roots.push(root);
	return loadTarget(root);
}

function commit(target: ResolvedTarget): ResolvedTarget {
	gitText(target.dir, ["add", "."]);
	gitText(target.dir, ["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "source fixture"]);
	return { ...target, gitSha: gitText(target.dir, ["rev-parse", "HEAD"]) };
}

describe("declared KB tree binding", () => {
	it("changes for every committed KB byte, file addition/removal and mode, not unrelated commits", () => {
		let target = fixture();
		const initial = captureCorpusSourceBinding(target);
		expect(initial).toEqual({
			algorithmId: "declared-kb-trees-v1", targetId: "test-target",
			roots: [{ path: "data/kb", treeSha: gitText(target.dir, ["rev-parse", "HEAD:data/kb"]) }],
		});
		const manifest = join(target.dir, "manifest.yaml");
		writeFileSync(manifest, readFileSync(manifest, "utf8").replace("graders: evals/graders.yaml", `graders: evals/graders.yaml
  judge:
    provider: qwen-internal
    id: independent-judge
    api: openai-completions
    baseUrl: http://127.0.0.1:9902/v1
    apiKeyEnv: TEST_JUDGE_KEY
    thinkingLevel: "off"
    timeoutMs: 300000`));
		target = commit(target);
		expect(captureCorpusSourceBinding(loadTarget(target.dir))).toEqual(initial);
		writeFileSync(join(target.dir, "AGENTS.md"), "Unrelated instructions\n");
		target = commit(target);
		expect(captureCorpusSourceBinding(target)).toEqual(initial);

		let previous = initial;
		for (const edit of [
			() => writeFileSync(join(target.dir, "data/kb/private/internal.bin"), Buffer.from([0, 255, 1])),
			() => writeFileSync(join(target.dir, "data/kb/new.txt"), "New policy\n"),
			() => rmSync(join(target.dir, "data/kb/new.txt")),
			() => chmodSync(join(target.dir, "data/kb/public/policy.md"), 0o755),
		]) {
			edit();
			target = commit(target);
			const next = captureCorpusSourceBinding(target);
			expect(next).not.toEqual(previous);
			previous = next;
		}
	});

	it("isolates declared subtrees, sorts and deduplicates roots, and notices declaration changes", () => {
		let target = fixture(["data/kb/public", "data/fixtures"]);
		const initial = captureCorpusSourceBinding(target);
		expect(initial.roots.map((root) => root.path)).toEqual(["data/kb/public"]);
		writeFileSync(join(target.dir, "data/kb/private/internal.bin"), "changed private data");
		target = commit(target);
		expect(captureCorpusSourceBinding(target)).toEqual(initial);
		const expanded = { ...target, manifest: { ...target.manifest, data: ["data/kb/public", "data/kb/private", "data/kb/public"] } };
		const binding = captureCorpusSourceBinding(expanded);
		expect(binding.roots.map((root) => root.path)).toEqual(["data/kb/private", "data/kb/public"]);
		expect(binding).not.toEqual(initial);
		expect(captureCorpusSourceBinding({ ...target, manifest: { ...target.manifest, data: [] } }).roots).toEqual([]);
	});

	it.each(["modified", "staged", "untracked"] as const)("refuses %s work without changing anything", (kind) => {
		const target = fixture();
		const path = kind === "untracked" ? "data/kb/new.md" : "data/kb/public/policy.md";
		writeFileSync(join(target.dir, path), "Operator edits\n");
		if (kind === "staged") gitText(target.dir, ["add", path]);
		const before = gitText(target.dir, ["status", "--porcelain=v1"]);
		expect(() => captureCorpusSourceBinding(target)).toThrow(/uncommitted|dirty/i);
		expect(gitText(target.dir, ["status", "--porcelain=v1"])).toBe(before);
		expect(readFileSync(join(target.dir, path), "utf8")).toBe("Operator edits\n");
	});

	it("rejects stale revisions and non-root repositories while ignoring the host's local store", () => {
		const target = fixture();
		mkdirSync(join(target.dir, ".ahde"));
		writeFileSync(join(target.dir, ".ahde", "state.json"), "{}");
		expect(captureCorpusSourceBinding(target).roots).toHaveLength(1);
		expect(() => captureCorpusSourceBinding({ ...target, dir: join(target.dir, "data") })).toThrow(/worktree root/);
		writeFileSync(join(target.dir, "AGENTS.md"), "New commit\n");
		commit(target);
		expect(() => captureCorpusSourceBinding(target)).toThrow(/changed|stale/i);
		expect(() => captureCorpusSourceBinding({ ...target, gitSha: "HEAD" })).toThrow();
	});

	it.each(["missing", "blob", "symlink", "symlink-parent"] as const)("refuses a %s KB root without following it", (kind) => {
		let target = fixture();
		rmSync(join(target.dir, "data/kb"), { recursive: true });
		if (kind === "blob") writeFileSync(join(target.dir, "data/kb"), "not a directory");
		if (kind.startsWith("symlink")) symlinkSync("fixtures", join(target.dir, "data/kb"));
		target = commit(target);
		if (kind === "symlink-parent") target = { ...target, manifest: { ...target.manifest, data: ["data/kb/child"] } };
		expect(() => captureCorpusSourceBinding(target)).toThrow(/KB root.*(tree|directory)/);
	});

	it("ignores Git replacement objects and never reloads a Target or reads KB content", () => {
		const target = fixture();
		const initial = captureCorpusSourceBinding(target);
		const replacement = gitText(target.dir, ["rev-parse", "HEAD:data/fixtures"]);
		gitText(target.dir, ["replace", initial.roots[0]!.treeSha, replacement]);
		expect(execFileSync("git", ["-C", target.dir, "ls-tree", "HEAD:data/kb"], { encoding: "utf8" })).toContain("account.json");
		const reload = vi.spyOn(manifestModule, "loadTarget").mockImplementation(() => { throw new Error("Must not reload or prepare tools"); });
		const git = vi.spyOn(gitCommands, "git");
		Object.defineProperty(target, "tools", { get: () => { throw new Error("Must not access tool setup"); } });
		Object.defineProperty(target, "data", { get: () => { throw new Error("Must not walk data directories"); } });
		expect(captureCorpusSourceBinding(target)).toEqual(initial);
		expect(reload).not.toHaveBeenCalled();
		expect(git.mock.calls.every(([, args]) => !args.includes("cat-file") && !args.includes("show"))).toBe(true);
		expect(existsSync(join(target.dir, ".ahde"))).toBe(false);
	});

	it("returns an empty binding without Git access for a Target with no declared KB", () => {
		const target = fixture([]);
		const git = vi.spyOn(gitCommands, "git").mockImplementation(() => { throw new Error("No Git for empty roots"); });
		expect(captureCorpusSourceBinding({ ...target, dir: "/does-not-exist", gitSha: "uncommitted" })).toEqual({
			algorithmId: "declared-kb-trees-v1", targetId: target.manifest.id, roots: [],
		});
		expect(git).not.toHaveBeenCalled();
	});

	it.each(["data/kbx", "data/kb/../private", "data/kb//public", "data/kb/public/", "data/kb/.hidden", "/data/kb", "data/kb/x:y", "data/kb/a\\b"])("refuses unsafe binding path %s", (path) => {
		expect(CorpusSourceBindingSchema.safeParse({
			algorithmId: "declared-kb-trees-v1", targetId: "test-target", roots: [{ path, treeSha: "a".repeat(40) }],
		}).success).toBe(false);
	});

	it("rejects unsafe declarations before Git access, and rejects noncanonical stored roots", () => {
		const target = fixture();
		expect(() => captureCorpusSourceBinding({ ...target, manifest: { ...target.manifest, data: ["data/kb/../private"] } })).toThrow();
		const binding = captureCorpusSourceBinding(target);
		for (const malformed of [
			{ ...binding, algorithmId: "unknown" },
			{ ...binding, targetId: "x".repeat(101) },
			{ ...binding, roots: [...binding.roots, ...binding.roots] },
			{ ...binding, roots: [{ path: "data/kb", treeSha: "A".repeat(40) }] },
			{ ...binding, roots: [{ path: "data/kb/z", treeSha: "a".repeat(40) }, { path: "data/kb/a", treeSha: "b".repeat(40) }] },
		]) expect(CorpusSourceBindingSchema.safeParse(malformed).success).toBe(false);
	});
});

describe("host-owned corpus draft source binding", () => {
	it.each([false, true])("preserves legacy hashes and persists bound v4 identity (production provenance: %s)", (production) => {
		const target = fixture();
		const sourceBinding = captureCorpusSourceBinding(target);
		const stateRoot = join(target.dir, ".ahde");
		const snapshot = saveSpecSnapshot({
			stateRoot, projectId: target.manifest.id, status: "approved", now: () => NOW,
			spec: {
				schemaVersion: 1, title: "Refund assistant", purpose: "Answer refund questions",
				users: ["Customers"], jobs: ["Answer questions"], inputs: ["Question"],
				allowedActions: ["Read policy"], successCriteria: ["Correct answer"], constraints: ["No inventions"], openQuestions: [],
			},
		});
		const approvedSpec = loadApprovedSpec({ stateRoot, projectId: target.manifest.id, specId: snapshot.id }).reference;
		const task = BuilderCorpusDraftTaskInputSchema.parse({ input: "Refund window?", expected: "30 days", graders: [{ type: "exact" }] });
		const provenance = BuilderCorpusDraftTaskProvenanceSchema.parse({
			kind: "production-failure", taskId: builderCorpusDraftTaskId(approvedSpec, task),
			source: {
				schemaVersion: 1, failureId: `failure-${"1".repeat(64)}`, failureHash: `sha256:${"2".repeat(64)}`,
				source: { kind: "real", path: "imports/incident.jsonl", sha256: `sha256:${"3".repeat(64)}` },
				redactedSha256: `sha256:${"4".repeat(64)}`, importedAgainst: { id: target.manifest.id, gitSha: target.gitSha },
				targetClaim: null, toolEvidence: { authority: "reported", eventCount: 0, omittedCount: 0 },
			},
		});
		const options = {
			stateRoot, approvedSpec, name: "Refund cases", tasks: [task], revisionSummary: "Initial",
			...(production ? { verifiedTaskProvenance: [provenance] } : {}),
		};
		const legacy = createBuilderCorpusDraft(options, { now: () => NOW }).draft;
		const identity = {
			schemaVersion: production ? 3 : 2, kind: "builder-corpus-draft", projectId: target.manifest.id,
			approvedSpec, parentDraftId: null, name: options.name, tasks: legacy.tasks,
			...(production ? { taskProvenance: [provenance] } : {}), coverageNotes: [], revisionSummary: "Initial", source: "builder-pi",
		};
		expect(legacy.id).toBe(`corpus-draft-${hashValue(identity).slice("sha256:".length)}`);
		expect(legacy).not.toHaveProperty("sourceBinding");
		expect(BuilderCorpusDraftSchema.parse({ ...identity, id: legacy.id, createdAt: NOW })).toEqual(legacy);
		const bound = createBuilderCorpusDraft({ ...options, sourceBinding }, { now: () => NOW });
		expect(bound.draft).toMatchObject({ schemaVersion: 4, sourceBinding, tasks: legacy.tasks });
		expect(bound.draft.id).toBe(`corpus-draft-${hashValue({ ...identity, schemaVersion: 4, sourceBinding }).slice("sha256:".length)}`);
		expect(createBuilderCorpusDraft({ ...options, sourceBinding }, { now: () => "2026-09-08T12:00:00.000Z" })).toEqual(bound);
		expect(loadBuilderCorpusDraft(stateRoot, target.manifest.id, bound.draft.id)).toEqual(bound.draft);
		expect(BuilderCorpusDraftSchema.safeParse({ ...bound.draft, schemaVersion: legacy.schemaVersion }).success).toBe(false);
		expect(BuilderCorpusDraftSchema.safeParse({ ...legacy, schemaVersion: 4 }).success).toBe(false);
		expect(BuilderCorpusDraftSchema.safeParse({ ...bound.draft, sourceBinding: { ...sourceBinding, roots: [] } }).success).toBe(false);
		expect(WorkbenchSubmitInputSchema.safeParse({ kind: "corpus-draft", name: options.name, tasks: [task], revisionSummary: "Initial", sourceBinding }).success).toBe(false);

		writeFileSync(join(target.dir, "data/kb/public/policy.md"), "Refunds within 14 days.\n");
		const fresh = captureCorpusSourceBinding(commit(target));
		const changed = createBuilderCorpusDraft({ ...options, sourceBinding: fresh });
		expect(changed.draft.id).not.toBe(bound.draft.id);
		const empty = createBuilderCorpusDraft({ ...options, sourceBinding: { ...fresh, roots: [] } }).draft;
		expect(empty.schemaVersion).toBe(4);
		let parent = bound.draft;
		for (const operation of [
			{ type: "rename", name: "Renamed" },
			{ type: "set-graders", taskId: parent.tasks[0]!.id, graders: [{ type: "output_contains", text: "days" }] },
		]) {
			const revised = reviseBuilderCorpusDraft({
				stateRoot, approvedSpec, parentDraftId: parent.id, operations: [operation], revisionSummary: "Keep original source",
			});
			expect(revised.draft).toMatchObject({ schemaVersion: 4, sourceBinding });
			expect(loadBuilderCorpusDraft(stateRoot, target.manifest.id, parent.id)).toEqual(parent);
			parent = revised.draft;
		}
		const before = listBuilderCorpusDrafts(stateRoot, target.manifest.id);
		expect(() => createBuilderCorpusDraft({ ...options, sourceBinding: { ...fresh, roots: [{ path: "data/kb/../x", treeSha: "a".repeat(40) }] } })).toThrow();
		expect(listBuilderCorpusDrafts(stateRoot, target.manifest.id)).toEqual(before);
	});
});
