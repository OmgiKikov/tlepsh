import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCorpus } from "../src/corpus.js";
import { targetWithDevelopmentCorpus } from "../src/application/corpus-target.js";
import { loadVerifiedEvalRun, runSuite, type EvalRunRecord } from "../src/eval.js";
import * as evals from "../src/eval.js";
import { loadTarget } from "../src/manifest.js";
import { hashValue } from "../src/provenance.js";
import { createAhdeWorkbench } from "../src/workbench/index.js";
import { CURRENT_FINDING_MAX_RUNS, currentFindingFromInventory } from "../src/workbench/current-finding.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";
import { gate, git, spec } from "./helpers/cycle-fixtures.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) cleanup(root); });

async function fixture(measure = true) {
	vi.stubEnv("CURRENT_FINDING_TEST_KEY", "offline-fixture-key");
	const manifest = `id: test-target
model:
  provider: openai-compatible
  id: offline-agent
  api: openai-completions
  baseUrl: http://127.0.0.1:9/v1
  apiKeyEnv: CURRENT_FINDING_TEST_KEY
  thinkingLevel: "off"
  timeoutMs: 10000
execution:
  kind: command
  command:
    argv: [${JSON.stringify(process.execPath)}, agent.mjs]
    protocolVersion: 2
  tools: [read]
  sandbox: best-effort
  network: deny
instructions: { agentsMd: AGENTS.md }
skills: []
evalSuite:
  id: finding-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`;
	const projectDir = makeTargetFixture(baseFixtureFiles({
		".gitignore": ".ahde/\nruns/\n",
		"manifest.yaml": manifest,
		"evals/development.jsonl": JSON.stringify({ id: "ticket", input: "Create a ticket", graders: [{ type: "output_contains", text: "ticket" }] }),
		"agent.mjs": `import {createInterface} from "node:readline";
createInterface({input: process.stdin}).on("line", line => {
  const message=JSON.parse(line);
  if(message.type==="cancel") process.exit(0);
  if(message.type==="user") process.stdout.write(JSON.stringify({v:2,type:"assistant",turn:message.turn,text:"I created the ticket."})+"\\n");
});`,
	}));
	roots.push(projectDir);
	loadTarget(projectDir);
	const paths = { projectDir, runsRoot: join(projectDir, "runs"), stateRoot: join(projectDir, ".ahde"), projectId: "test-target" };
	const evaluate = vi.fn<typeof runSuite>();
	const workbench = createAhdeWorkbench({ ...paths, dependencies: { runSuite: evaluate } });
	await workbench.submit({ kind: "spec-draft", spec: spec() });
	await workbench.decide({ kind: "approve-spec", reason: "Approve current observation fixture" }, gate());
	await workbench.submit({ kind: "corpus-draft", name: "Current checks", coverageNotes: [], revisionSummary: "Known ticket outcome", tasks: [{
		input: "Create my support ticket.", graders: [{ type: "output_contains", text: "ticket" }],
		world: { state: { tickets: [] }, expect: [{ path: "tickets.0.id", op: "exists" }] },
	}] });
	const publication = await workbench.decide({ kind: "publish-corpus", reason: "Publish current reviewed checks" }, gate());
	const target = targetWithDevelopmentCorpus(loadTarget(projectDir), loadCorpus({ ...paths, corpusId: publication.result.corpusId }));
	const evaluation = measure ? await runSuite(target, { runsRoot: paths.runsRoot, label: "solo", repetitions: 1, jobs: 1 }) : null;
	return { ...paths, workbench, evaluate, evaluation };
}

function storedFiles(root: string): string[] {
	return readdirSync(root, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && !relative(root, join(entry.parentPath, entry.name)).startsWith(".git/"))
		.map((entry) => `${relative(root, join(entry.parentPath, entry.name))}:${hashValue(readFileSync(join(entry.parentPath, entry.name), "utf8"))}`).sort();
}

describe("the current agent's first recorded finding", () => {
	it("reads the real final-state failure without any new decision, model call or artifact", async () => {
		const f = await fixture();
		const before = storedFiles(f.projectDir);
		const view = await f.workbench.view();
		expect(view.blockers).toEqual([]);
		expect(view.finding?.evalRunId).toBe(f.evaluation!.evalRunId);
		expect(view.finding?.reading.kind).toBe("world");
		expect(view.finding?.reading.observations.join(" ")).toContain("tickets.0.id");
		expect(view.finding?.reading.answerQuote?.text).toBe("I created the ticket.");
		expect(view.finding?.reading.runId).toBe(f.evaluation!.runIds[0]);
		expect(storedFiles(f.projectDir)).toEqual(before);
		expect(f.evaluate).not.toHaveBeenCalled();
	});

	it("shows readiness with no evidence and does not invent an observation", async () => {
		const f = await fixture(false);
		const view = await f.workbench.view();
		expect(view.finding).toBeUndefined();
		expect(view.stage).toBe("ready-to-evaluate");
		expect(f.evaluate).not.toHaveBeenCalled();
	});

	it("drops a finding after the active Target revision changes", async () => {
		const f = await fixture();
		expect((await f.workbench.view()).finding).toBeDefined();
		writeFileSync(join(f.projectDir, "AGENTS.md"), "# Changed behavior\n");
		git(f.projectDir, "add", "AGENTS.md"); git(f.projectDir, "commit", "-qm", "Change active harness");
		const current = await f.workbench.view();
		expect(current.finding).toBeUndefined();
		expect(current.stage).toBe("ready-to-evaluate");
	});

	it.each(["runtime", "model", "unmarked-command"] as const)("keeps verified but stale %s evidence readable without presenting it as current", async (axis) => {
		const f = await fixture();
		const verified = loadVerifiedEvalRun(f.runsRoot, f.evaluation!.evalRunId);
		const run = structuredClone(verified.runs[0]!);
		const index = structuredClone(verified.record);
		if (axis === "runtime") { run.runtime.piSha = "a".repeat(40); index.provenance.piSha = run.runtime.piSha; }
		if (axis === "model") { run.model.id = "previous-model"; index.provenance.modelId = run.model.id; }
		if (axis === "unmarked-command") { delete run.execution.commandProtocol; delete index.provenance.execution.commandProtocol; }
		index.provenanceKey = hashValue(index.provenance);
		index.runArtifacts = [{ runId: run.runId, sha256: hashValue(run) }];
		writeFileSync(join(f.runsRoot, run.runId, "run.json"), JSON.stringify(run));
		writeFileSync(join(f.runsRoot, index.evalRunId, "eval_run.json"), JSON.stringify(index));
		expect(loadVerifiedEvalRun(f.runsRoot, index.evalRunId).runs).toHaveLength(1);
		expect((await f.workbench.view()).finding).toBeUndefined();
		expect(f.evaluate).not.toHaveBeenCalled();
	});

	it("refuses sealed redirection before touching a canary member path", async () => {
		const f = await fixture();
		const inventory = f.workbench.inventory();
		const view = await f.workbench.view();
		const sealed: EvalRunRecord = { ...f.evaluation!, evidenceVisibility: "sealed", runIds: ["run_private_canary"],
			runArtifacts: [{ runId: "run_private_canary", sha256: hashValue("private canary") }] };
		writeFileSync(join(f.runsRoot, sealed.evalRunId, "eval_run.json"), JSON.stringify(sealed));
		const memberRead = vi.spyOn(evals, "loadVerifiedEvalRun");
		expect(currentFindingFromInventory({ ...inventory, developmentEvals: [sealed] }, view)).toBeNull();
		expect(memberRead).not.toHaveBeenCalled();
		expect((await f.workbench.view()).finding).toBeUndefined();
	});

	it("hides a damaged trace and a blocked project's old finding", async () => {
		const f = await fixture();
		const inventory = f.workbench.inventory();
		const view = await f.workbench.view();
		expect(currentFindingFromInventory(inventory, { ...view, blockers: ["Resolve current selection"] })).toBeNull();
		writeFileSync(join(f.runsRoot, f.evaluation!.runIds[0]!, "session.jsonl"), "tampered");
		expect((await f.workbench.view()).finding).toBeUndefined();
	});

	it("does not reuse the previous basket's finding after publishing a new reviewed corpus", async () => {
		const f = await fixture();
		expect((await f.workbench.view()).finding).toBeDefined();
		await f.workbench.submit({ kind: "corpus-draft", name: "New approved surface", tasks: [{ input: "A different question", graders: [{ type: "output_contains", text: "different" }] }], coverageNotes: [], revisionSummary: "Add the new requirement" });
		await f.workbench.decide({ kind: "publish-corpus", reason: "Use the new reviewed requirements" }, gate());
		const view = await f.workbench.view();
		expect(view.finding).toBeUndefined();
		expect(view.stage).toBe("ready-to-evaluate");
	});

	it("bounds startup before loading any member of an oversized evaluation", async () => {
		const f = await fixture();
		const inventory = f.workbench.inventory();
		const view = await f.workbench.view();
		const total = CURRENT_FINDING_MAX_RUNS + 1;
		const runIds = Array.from({ length: total }, (_, i) => `run_unread_canary_${i}`);
		const large: EvalRunRecord = { ...f.evaluation!, runIds, runArtifacts: runIds.map((runId) => ({ runId, sha256: hashValue(runId) })),
			summary: { total, pass: 0, fail: total, error: 0, allPassRate: 0 } };
		writeFileSync(join(f.runsRoot, large.evalRunId, "eval_run.json"), JSON.stringify(large));
		const memberRead = vi.spyOn(evals, "loadVerifiedEvalRun");
		expect(currentFindingFromInventory({ ...inventory, developmentEvals: [large] }, view)).toBeNull();
		expect(memberRead).not.toHaveBeenCalled();
		expect(f.evaluate).not.toHaveBeenCalled();
	});
});
