import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAhdeWorkbench } from "../src/workbench/workbench.js";
import { deriveWorkbenchView, loadWorkbenchInventory, type WorkbenchInventory } from "../src/workbench/inventory.js";
import type { SpecSnapshot } from "../src/spec.js";
import { setLanguage } from "../src/i18n.js";
import { createCorpus } from "../src/corpus.js";
import * as evals from "../src/eval.js";
import { hashValue, provenanceAxes, RunRecordSchema } from "../src/provenance.js";
import { writeJsonArtifact } from "../src/storage/artifacts.js";
import { baseRunRecord } from "./helpers/judge-fixtures.js";
import { CORPUS_INVENTORY_FAULTS, damageCorpusInventory } from "./helpers/corpus-inventory.js";
import { createCandidate, transitionCandidate } from "../src/domain/candidate.js";
import * as evidence from "../src/evidence/model.js";

const roots: string[] = [];

function root(): string {
	const path = mkdtempSync(join(tmpdir(), "ahde-inventory-seam-"));
	roots.push(path);
	return path;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function writeLegacyEval(runsRoot: string, evalRunId: string, datasetHash: string) {
	const base = baseRunRecord();
	const run = baseRunRecord({
		runId: `${evalRunId}-run`,
		eval: { ...base.eval, datasetHash },
		parent: { evalRunId, candidateOf: null },
	});
	writeJsonArtifact(join(runsRoot, run.runId, "run.json"), RunRecordSchema, run);
	const provenance = provenanceAxes({ runtime: run.runtime, model: run.model, judge: null, execution: run.execution, eval: run.eval });
	const record: evals.EvalRunRecord = {
		schemaVersion: 3, purpose: "evidence", evalRunId,
		target: run.target, label: run.label, baselineEvalRunId: null,
		provenance, provenanceKey: hashValue(provenance),
		suiteId: run.eval.suiteId, suiteHash: run.eval.suiteHash,
		dataset: run.eval.dataset, datasetHash, evidenceVisibility: "development",
		taskIds: [run.taskId], repetitions: 1, runIds: [run.runId],
		runArtifacts: [{ runId: run.runId, sha256: hashValue(run) }],
		startedAt: run.startedAt, finishedAt: run.finishedAt!,
		summary: { total: 1, pass: 1, fail: 0, error: 0, allPassRate: 1 },
	};
	evals.writeEvalRun(runsRoot, record);
	writeFileSync(join(runsRoot, evalRunId, "eval_run.json"), JSON.stringify({ ...record, evidenceVisibility: undefined }));
	return record;
}

function draft(projectId: string): SpecSnapshot {
	return {
		schemaVersion: 1,
		id: "spec-0000000000000000000000000000000000000000000000000000000000000001",
		projectId,
		status: "draft",
		spec: {
			schemaVersion: 1,
			title: "Support triage",
			purpose: "Classify support requests.",
			users: ["support operator"],
			jobs: ["classify one request"],
			inputs: ["request text"],
			allowedActions: ["read the public policy"],
			successCriteria: ["classification matches the rubric"],
			constraints: ["no network"],
			openQuestions: [],
		},
		sourceHash: null,
		createdAt: "2026-08-29T00:00:00.000Z",
	} as SpecSnapshot;
}

function workbenchOver(projectDir: string, inventory: (base: WorkbenchInventory) => WorkbenchInventory) {
	const options = {
		projectDir,
		stateRoot: join(projectDir, ".ahde"),
		runsRoot: join(projectDir, "runs"),
		projectId: "demo",
	};
	let loads = 0;
	const workbench = createAhdeWorkbench({
		...options,
		dependencies: {
			loadInventory: (input) => {
				loads += 1;
				return inventory(loadWorkbenchInventory(input));
			},
		},
	});
	return { workbench, loads: () => loads };
}

describe("Workbench inventory read behind the seam", () => {
	it.each(["baseline", "candidate"] as const)("never reopens a legacy sealed %s arm through candidate review", (hiddenArm) => {
		const projectDir = root();
		const options = { projectDir, stateRoot: join(projectDir, ".ahde"), runsRoot: join(projectDir, "runs"), projectId: "demo" };
		const sealed = createCorpus({ ...options, name: "sealed sentinel", visibility: "sealed",
			tasks: [{ id: "secret", input: "private case", graders: [{ type: "output_contains", text: "ok" }] }],
		});
		const a = writeLegacyEval(options.runsRoot, "erun_a", hiddenArm === "baseline" ? sealed.hash : `sha256:${"e".repeat(64)}`);
		writeLegacyEval(options.runsRoot, "erun_b", hiddenArm === "candidate" ? sealed.hash : `sha256:${"e".repeat(64)}`);
		const inventory = loadWorkbenchInventory(options);
		expect(inventory.developmentEvals).toHaveLength(1);
		const baseline = { ref: "main", sha: a.target.gitSha };
		const actor = { kind: "human" as const, id: "reviewer" };
		const at = "2026-09-07T00:00:00.000Z";
		let record = createCandidate({ candidateId: "legacy-candidate", projectId: "demo", targetId: a.target.id,
			specId: null, proposalId: "proposal", diagnosisId: null, origin: { kind: "manual", reason: "legacy fixture" },
			mode: "aa-calibration", baseline, eventId: "proposed", at, actor,
		});
		record = transitionCandidate(record, { type: "built", eventId: "built", at, actor, candidate: baseline });
		record = transitionCandidate(record, { type: "validated", eventId: "validated", at, actor,
			lineage: { baseline, candidate: baseline, relation: "same" },
			scope: { policyId: "harness", baselineSha: baseline.sha, candidateSha: baseline.sha, passed: true, changedFiles: [], violations: [] },
		});
		record = transitionCandidate(record, { type: "evaluated", eventId: "evaluated", at, actor,
			evaluation: { experimentId: "legacy-candidate", designHash: hashValue("design"), mode: "aa-calibration",
				development: { baseline: { evalRunId: "erun_a", harness: baseline }, candidate: { evalRunId: "erun_b", harness: baseline } },
				infrastructureErrors: 0,
			},
		});
		const read = vi.spyOn(evidence, "loadPublicEvalRun");
		const summary = createAhdeWorkbench(options).candidateView(record, inventory.developmentEvals);
		expect(read).not.toHaveBeenCalled();
		expect(summary.cases).toBeNull();
		expect(summary.casesTotal).toBeUndefined();
	});

	it.each(CORPUS_INVENTORY_FAULTS)("suppresses legacy evaluations on %s before loading their members", (fault) => {
		const projectDir = root();
		const options = { projectDir, stateRoot: join(projectDir, ".ahde"), runsRoot: join(projectDir, "runs"), projectId: "demo" };
		const corpus = createCorpus({
			...options, name: "private-inventory-sentinel", visibility: "sealed",
			tasks: [{ id: "secret", input: "private case", graders: [{ type: "output_contains", text: "ok" }] }],
		});
		writeLegacyEval(options.runsRoot, "erun_private", corpus.hash);
		writeLegacyEval(options.runsRoot, "erun_public", `sha256:${"e".repeat(64)}`);
		expect(loadWorkbenchInventory(options).developmentEvals.map((run) => run.evalRunId)).toEqual(["erun_public"]);
		const load = vi.spyOn(evals, "loadEvalRun");
		const restore = damageCorpusInventory({ ...options, corpusId: corpus.id }, fault);
		try {
			const inventory = loadWorkbenchInventory(options);
			expect(inventory.developmentEvals).toEqual([]);
			expect(load).not.toHaveBeenCalled();
			expect(inventory.integrityBlockers).toContain("evaluation inventory failed integrity checks; sealed identities remain hidden");
			const view = deriveWorkbenchView(inventory);
			expect(view.counts.developmentEvals).toBe(0);
			expect(view.selections.some((selection) => selection.kind === "eval-run")).toBe(false);
			const serialized = JSON.stringify(view);
			for (const hidden of ["erun_private", corpus.id, corpus.hash, corpus.name]) expect(serialized).not.toContain(hidden);
		} finally {
			restore();
		}
	});

	it("keeps legacy development evidence available when there is no corpus store yet", () => {
		const projectDir = root();
		const options = { projectDir, stateRoot: join(projectDir, ".ahde"), runsRoot: join(projectDir, "runs"), projectId: "demo" };
		writeLegacyEval(options.runsRoot, "erun_public", `sha256:${"e".repeat(64)}`);
		const inventory = loadWorkbenchInventory(options);
		expect(inventory.developmentEvals.map((run) => run.evalRunId)).toEqual(["erun_public"]);
		expect(inventory.integrityBlockers).toEqual([]);
	});

	it("reads durable state only through the injected loader", async () => {
		const projectDir = root();
		const { workbench, loads } = workbenchOver(projectDir, (base) => ({
			...base,
			warnings: [...base.warnings, "served from memory"],
		}));

		const view = await workbench.view();
		expect(loads()).toBe(1);
		expect(view.warnings).toContain("served from memory");
	});

	it("reports a write from the state it already read instead of reading twice", async () => {
		const projectDir = root();
		const spec = draft("demo");
		const { workbench, loads } = workbenchOver(projectDir, (base) => ({ ...base, specs: [spec] }));

		const turn = await workbench.submit({ kind: "select", entity: "spec-draft", id: spec.id });
		// One read for the selection; the trailing view reports that same state.
		expect(loads()).toBe(1);
		expect(turn.view.focus["spec-draft"]).toBe(spec.id);
		expect(turn.view.selections.some((selection) => selection.id === spec.id && selection.selected)).toBe(true);
	});

	// The basket's own label is read on the focus line, where `8 tasks` was one
	// of seven English words in a Russian sentence.
	it("bends the case count in a basket label with the operator's language", async () => {
		const projectDir = root();
		const corpus = {
			id: "corpus-1",
			name: "ombudsman-main",
			visibility: "development" as const,
			taskCount: 8,
			hash: `sha256:${"a".repeat(64)}`,
			createdAt: "2026-08-29T00:00:00.000Z",
		};
		const { workbench } = workbenchOver(projectDir, (base) => ({
			...base,
			corpora: [corpus as unknown as WorkbenchInventory["corpora"][number]],
		}));
		setLanguage("ru");
		try {
			const view = await workbench.view();
			const basket = view.selections.find((selection) => selection.kind === "development-corpus");
			expect(basket?.label).toBe("ombudsman-main · 8 задач");
		} finally {
			setLanguage(null);
		}
	});
});
