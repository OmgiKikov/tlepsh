import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAhdeWorkbench } from "../src/workbench/workbench.js";
import { loadWorkbenchInventory, type WorkbenchInventory } from "../src/workbench/inventory.js";
import type { SpecSnapshot } from "../src/spec.js";
import { setLanguage } from "../src/i18n.js";

const roots: string[] = [];

function root(): string {
	const path = mkdtempSync(join(tmpdir(), "ahde-inventory-seam-"));
	roots.push(path);
	return path;
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

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
