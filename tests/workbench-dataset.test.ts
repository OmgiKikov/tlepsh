import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBuilderCorpusDraft } from "../src/application/builder-corpus-draft.js";
import type { DatasetMappingRecipe } from "../src/application/dataset-ingest.js";
import { listDatasetRecipeSubmissions } from "../src/application/dataset-recipe.js";
import { renderConfirmation } from "../src/builder/render/confirmation.js";
import { renderDecision } from "../src/builder/render/decision.js";
import { plainPaint } from "../src/builder/render/paint.js";
import { renderView } from "../src/builder/render/view.js";
import { listCorpora, loadCorpus } from "../src/corpus.js";
import type { AgentSpec } from "../src/spec.js";
import {
	createAhdeWorkbench,
	type AhdeWorkbench,
	type WorkbenchConfirmation,
	type WorkbenchHumanGate,
} from "../src/workbench/index.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";
import { createHostContext, invokeTool, productionTools } from "./helpers/builder-tools.js";

const NOW = "2026-08-29T09:00:00.000Z";
const PROJECT = "test-target";
const SOURCE = "imports/tickets.csv";
const roots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) cleanup(root);
});

function spec(): AgentSpec {
	return {
		schemaVersion: 1,
		title: "Support policy assistant",
		purpose: "Answer support policy questions from approved local evidence.",
		users: ["Support operators"],
		jobs: ["Answer one policy question"],
		inputs: ["A policy question"],
		allowedActions: ["Read approved local policy"],
		successCriteria: ["Answer contains the applicable policy"],
		constraints: ["Never invent policy"],
		openQuestions: [],
	};
}

interface RecordingGate extends WorkbenchHumanGate {
	confirmations: WorkbenchConfirmation[];
}

function gate(approved = true): RecordingGate {
	const confirmations: WorkbenchConfirmation[] = [];
	return {
		confirmations,
		confirm: async (confirmation) => {
			confirmations.push(confirmation);
			return { approved, ...(approved ? { actorId: "local:test-human" } : {}) };
		},
		selectSealed: async () => ({ approved: false }),
	};
}

/** Rows a human would actually export: a question, a reference answer, a tier, a prior turn. */
function ticketRows(count: number): string {
	const rows = ["question,answer,tier,history"];
	for (let index = 1; index <= count; index += 1) {
		const question = `Is refund ticket ${index} inside the window?`;
		const history = JSON.stringify([
			{ role: "user", content: `Ticket ${index} was opened last month.` },
			{ role: "assistant", content: "Noted. What would you like to know?" },
		]).replace(/"/g, '""');
		rows.push(`${question},${index % 2 === 0 ? "30 days" : "14 days"},${index % 3 === 0 ? "gold" : "standard"},"${history}"`);
	}
	return `${rows.join("\n")}\n`;
}

function recipe(overrides: Record<string, unknown> = {}): DatasetMappingRecipe {
	return {
		schemaVersion: 1,
		input: { column: "question" },
		expected: { column: "answer" },
		dialogue: { column: "history" },
		metadata: ["tier"],
		graders: [{ type: "output_contains", text: "{{expected}}" }],
		...overrides,
	} as DatasetMappingRecipe;
}

async function approvedProject(rows = 24): Promise<{
	workbench: AhdeWorkbench;
	projectDir: string;
	stateRoot: string;
	runsRoot: string;
}> {
	const projectDir = makeTargetFixture(baseFixtureFiles({ ".gitignore": ".ahde/\nruns/\n" }));
	roots.push(projectDir);
	const paths = { projectDir, stateRoot: join(projectDir, ".ahde"), runsRoot: join(projectDir, "runs") };
	const workbench = createAhdeWorkbench({ ...paths, projectId: PROJECT, dependencies: { now: () => NOW } });
	await workbench.submit({ kind: "spec-draft", spec: spec() });
	await workbench.decide({ kind: "approve-spec", reason: "Approve the exact contract" }, gate());
	mkdirSync(join(projectDir, "imports"));
	writeFileSync(join(projectDir, "imports", "tickets.csv"), ticketRows(rows), "utf8");
	return { workbench, ...paths };
}

describe("dataset → benchmark through the Workbench", () => {
	it("previews an inbox file, compiles sample cases, and imports it into an editable draft", async () => {
		const { workbench, stateRoot } = await approvedProject();

		const preview = await workbench.view({ aspect: "dataset", resourcePath: SOURCE });
		expect(preview.detail).toMatchObject({
			aspect: "dataset",
			content: {
				sourcePath: SOURCE,
				preview: { format: "csv", rowCount: 24, holdout: null },
			},
		});
		const columns = preview.detail?.aspect === "dataset" ? preview.detail.content.preview.columns : [];
		expect(columns.map((column) => column.name)).toEqual(["question", "answer", "tier", "history"]);
		expect(columns[0]?.samples).toHaveLength(3);

		const proposed = await workbench.submit({
			kind: "dataset-recipe",
			sourcePath: SOURCE,
			recipe: recipe(),
			name: "Refund tickets",
			revisionSummary: "Map the exported tickets into cases",
		});
		expect(proposed.artifact).toMatchObject({
			submissionId: expect.stringMatching(/^dataset-recipe-[0-9a-f]{64}$/) as unknown as string,
			sourcePath: SOURCE,
			developmentCount: 24,
			skippedRows: 0,
			sealedReserved: 0,
		});
		const sample = (proposed.artifact?.sampleCases as { input: string; expected: string | null; metadata: Record<string, string> | null; messages: unknown[] | null }[])[0]!;
		expect(sample.input).toBe("Is refund ticket 1 inside the window?");
		expect(sample.expected).toBe("14 days");
		expect(sample.metadata).toEqual({ tier: "standard" });
		// The dialogue ends in the user turn that repeats `input`, so a runner that
		// only reads `input` still asks the same question.
		expect(sample.messages).toHaveLength(3);
		expect(listDatasetRecipeSubmissions(stateRoot, PROJECT)).toHaveLength(1);

		const approving = gate();
		const imported = await workbench.decide({
			kind: "import-dataset",
			sealed: { count: 6, seed: "exam-1", stratifyBy: "tier" },
			reason: "Import the exported tickets and reserve an exam",
		}, approving);
		expect(imported.result).toMatchObject({
			taskCount: 18,
			sealedCount: 6,
			sourcePath: SOURCE,
			skippedRows: 0,
		});
		expect(imported.view.stage).toBe("corpus-review");

		// The exam exists, and nothing development-facing names it.
		const sealed = listCorpora({ stateRoot, projectId: PROJECT }).filter((corpus) => corpus.visibility === "sealed");
		expect(sealed).toHaveLength(1);
		expect(sealed[0]?.taskCount).toBe(6);
		expect(JSON.stringify(imported)).not.toContain(sealed[0]!.id);
		expect(JSON.stringify(imported)).not.toMatch(/corpus-[0-9a-f]{64}/);

		const draft = loadBuilderCorpusDraft(stateRoot, PROJECT, imported.result.draftId);
		expect(draft.tasks).toHaveLength(18);
		const first = draft.tasks[0]!;
		expect(first.expected).toBeDefined();
		expect(first.metadata?.tier).toMatch(/^(gold|standard)$/);
		expect(first.messages?.[first.messages.length - 1]).toEqual({ role: "user", content: first.input });

		// Every sealed case is a row the development draft never saw.
		const sealedInputs = new Set(loadCorpus({ stateRoot, projectId: PROJECT, corpusId: sealed[0]!.id })
			.tasks.map((task) => task.input));
		expect(sealedInputs.size).toBe(6);
		for (const task of draft.tasks) expect(sealedInputs.has(task.input)).toBe(false);

		// A later preview of the same file replays the exact draw.
		const after = await workbench.view({ aspect: "dataset", resourcePath: SOURCE });
		expect(after.detail).toMatchObject({
			aspect: "dataset",
			content: { preview: { rowCount: 18, holdout: { reserved: 6, seed: "exam-1" } } },
		});
		const visibleRows = after.detail?.aspect === "dataset" ? after.detail.content.preview.sampleRows : [];
		for (const row of visibleRows) expect(sealedInputs.has(row.question ?? "")).toBe(false);
		expect(JSON.stringify(after.detail)).not.toMatch(/corpus-[0-9a-f]{64}/);
	});

	it("publishes the imported draft with its reference answers and dialogue intact", async () => {
		const { workbench, stateRoot } = await approvedProject(12);
		await workbench.submit({
			kind: "dataset-recipe",
			sourcePath: SOURCE,
			recipe: recipe(),
			name: "Refund tickets",
			revisionSummary: "Map the exported tickets into cases",
		});
		await workbench.decide({
			kind: "import-dataset",
			sealed: { count: 4, seed: "exam-1" },
			reason: "Import with a small exam",
		}, gate());
		const published = await workbench.decide({
			kind: "publish-corpus",
			reason: "Publish the reviewed imported basket",
		}, gate());

		const corpus = loadCorpus({ stateRoot, projectId: PROJECT, corpusId: published.result.corpusId });
		expect(corpus.tasks).toHaveLength(8);
		for (const task of corpus.tasks) {
			expect(task.expected).toBeDefined();
			expect(task.metadata?.tier).toBeDefined();
			expect(task.messages?.[task.messages.length - 1]?.content).toBe(task.input);
		}
	});

	it("answers a wrong column, a wrong placeholder, and an oversized basket calmly", async () => {
		const { workbench } = await approvedProject(24);
		const submit = (value: DatasetMappingRecipe) => workbench.submit({
			kind: "dataset-recipe",
			sourcePath: SOURCE,
			recipe: value,
			name: "Refund tickets",
			revisionSummary: "Map the exported tickets into cases",
		});

		await expect(submit(recipe({ input: { column: "prompt" } })))
			.rejects.toThrow(/the recipe names columns the dataset does not have: prompt/);
		await expect(submit(recipe({ graders: [{ type: "output_contains", text: "{{grade}}" }] })))
			.rejects.toThrow(/the recipe names columns the dataset does not have: grade/);
		await expect(submit(recipe({ graders: [{ type: "output_contains", text: "{{}}" }] })))
			.rejects.toThrow(/empty \{\{\}\} placeholder/);
		await expect(submit(recipe({ filters: [{ column: "tier", equals: "platinum" }] })))
			.rejects.toThrow(/compiled no cases/);

		const large = await approvedProject(140);
		await expect(large.workbench.submit({
			kind: "dataset-recipe",
			sourcePath: SOURCE,
			recipe: recipe(),
			name: "Refund tickets",
			revisionSummary: "Map every exported ticket",
		})).rejects.toThrow(/at most 100.*sample: \{ limit, seed \}/s);
	});

	it("refuses to draw a second exam over a file that already has one", async () => {
		const { workbench } = await approvedProject();
		await workbench.submit({
			kind: "dataset-recipe",
			sourcePath: SOURCE,
			recipe: recipe(),
			name: "Refund tickets",
			revisionSummary: "Map the exported tickets into cases",
		});
		await workbench.decide({
			kind: "import-dataset",
			sealed: { count: 6, seed: "exam-1" },
			reason: "Reserve the exam once",
		}, gate());
		for (const sealed of [null, { count: 8, seed: "exam-1" }, { count: 6, seed: "exam-2" }]) {
			await expect(workbench.decide({
				kind: "import-dataset",
				sealed,
				reason: "Try to redraw the exam",
			}, gate())).rejects.toThrow(/already holds out 6 rows with seed "exam-1"/);
		}
	});

	it("declines without importing anything and never leaves a partial exam", async () => {
		const { workbench, stateRoot } = await approvedProject();
		await workbench.submit({
			kind: "dataset-recipe",
			sourcePath: SOURCE,
			recipe: recipe(),
			name: "Refund tickets",
			revisionSummary: "Map the exported tickets into cases",
		});
		const declining = gate(false);
		await expect(workbench.decide({
			kind: "import-dataset",
			sealed: { count: 6, seed: "exam-1" },
			reason: "The operator says no",
		}, declining)).rejects.toThrow(/declined/i);
		expect(listCorpora({ stateRoot, projectId: PROJECT })).toEqual([]);
		expect(readdirSync(join(stateRoot, "projects", PROJECT))).not.toContain("dataset-ingests");
	});

	it("shows the human the mapping, the sample cases and the exam before anything happens", async () => {
		const { workbench } = await approvedProject();
		await workbench.submit({
			kind: "dataset-recipe",
			sourcePath: SOURCE,
			recipe: recipe(),
			name: "Refund tickets",
			revisionSummary: "Map the exported tickets into cases",
		});
		const approving = gate();
		const imported = await workbench.decide({
			kind: "import-dataset",
			sealed: { count: 6, seed: "exam-1", stratifyBy: "tier" },
			reason: "Import the exported tickets",
		}, approving);

		const confirmation = approving.confirmations[0]!;
		expect(confirmation.title).toBe("Import an exact dataset as eval cases");
		const lines = renderConfirmation(confirmation, plainPaint);
		const body = lines.join("\n");
		expect(body).toContain("File imports/tickets.csv · basket Refund tickets");
		expect(body).toContain("input ← question · expected ← answer · dialogue ← history · metadata ← tier");
		expect(body).toContain("Cases 18 development cases");
		expect(body).toContain("Sealed 6 rows drawn with seed exam-1 · stratified by tier");
		// Ticket 1 was drawn into the exam, so the human never sees it here either.
		expect(body).not.toContain("Is refund ticket 1 inside the window?");
		expect(body).toContain("Is refund ticket 2 inside the window?");
		expect(body).toContain("expected: 30 days");
		expect(body).toContain("dialogue: 3 turns ending in");
		expect(body).toContain("metadata: tier=standard");
		expect(body).toContain("graders: contains “30 days”");
		expect(body).toContain("Sealed rows are compiled first and never enter a development case or your context.");
		for (const line of lines) expect(line.length).toBeLessThanOrEqual(110);

		const decision = renderDecision(imported, plainPaint);
		expect(decision[0]).toContain("Dataset imported 18 cases from imports/tickets.csv");
		expect(decision[1]).toContain("Sealed 6 cases held out");
		expect(decision.join("\n")).not.toMatch(/corpus-[0-9a-f]{64}/);
		for (const line of decision) expect(line.length).toBeLessThanOrEqual(110);

		const preview = renderView(await workbench.view({ aspect: "dataset", resourcePath: SOURCE }), plainPaint);
		const previewBody = preview.join("\n");
		expect(previewBody).toContain("Dataset imports/tickets.csv · csv");
		expect(previewBody).toContain("Rows 18 rows · 4 columns · 6 reserved for the sealed exam");
		expect(previewBody).toMatch(/ {2}question {17}text {6}Is refund ticket 2 in… · /);
		expect(previewBody).toContain("Propose a recipe; the host compiles sample cases before anything is imported.");
		for (const line of preview) expect(line.length).toBeLessThanOrEqual(110);
	});

	it("fails the import closed when the host has no local TUI", async () => {
		const { projectDir, stateRoot, runsRoot, workbench } = await approvedProject();
		await workbench.submit({
			kind: "dataset-recipe",
			sourcePath: SOURCE,
			recipe: recipe(),
			name: "Refund tickets",
			revisionSummary: "Map the exported tickets into cases",
		});
		const tools: readonly ToolDefinition[] = productionTools({
			projectDir,
			stateRoot,
			runsRoot,
			projectId: PROJECT,
			dependencies: { actorId: () => "local:test-human" },
		});
		for (const mode of ["print", "rpc", "json"] as const) {
			const host = createHostContext({ hasUI: mode !== "print", mode });
			await expect(invokeTool(tools, "ahde_workbench_decide", {
				kind: "import-dataset",
				sealed: { count: 6, seed: "exam-1" },
				reason: "Import without a confirmation surface",
			}, host.ctx)).rejects.toThrow(/RPC, print, and JSON execution fail closed/);
		}
		expect(listCorpora({ stateRoot, projectId: PROJECT })).toEqual([]);
	});
});
