import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	improvementDesignCorpusRefs,
	improvementExperimentDesignPath,
	materializeImprovementExperimentDesign,
	planImprovementExperiment,
} from "../src/application/improvement-experiment-design.js";
import { createCorpus, loadCorpus } from "../src/corpus.js";

const roots: string[] = [];

function fixture(tasks: number) {
	const root = mkdtempSync(join(tmpdir(), "ahde-blind-design-"));
	roots.push(root);
	const stateRoot = join(root, "state");
	const runsRoot = join(root, "runs");
	const projectId = "blind-design-test";
	const metadata = createCorpus({
		stateRoot,
		projectId,
		name: "Reviewed support basket",
		visibility: "development",
		tasks: Array.from({ length: tasks }, (_, index) => ({
			id: `case-${index + 1}`,
			input: `Customer request ${index + 1}`,
			graders: [{ type: "output_contains" as const, text: "ok" }],
		})),
	});
	const corpus = loadCorpus({ stateRoot, projectId, corpusId: metadata.id });
	return { root, stateRoot, runsRoot, projectId, corpus };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("blind improvement experiment design", () => {
	it("refuses fewer than two authoring and two validation cases", () => {
		const value = fixture(3);
		expect(() => planImprovementExperiment(value.corpus, "loop_toosmall01"))
			.toThrow(/at least 4 reviewed cases/);
	});

	it("persists one deterministic, exact and disjoint split per loop", () => {
		const value = fixture(10);
		const loopId = "loop_blindtest01";
		const first = materializeImprovementExperimentDesign({
			...value,
			loopId,
			now: () => "2026-09-04T10:00:00.000Z",
		});
		const second = materializeImprovementExperimentDesign({
			...value,
			loopId,
			now: () => "2030-01-01T00:00:00.000Z",
		});

		expect(second).toEqual(first);
		expect(first.authoringTaskIds).toHaveLength(6);
		expect(first.validationTaskIds).toHaveLength(4);
		expect(first.authoringTaskIds.some((id) => first.validationTaskIds.includes(id))).toBe(false);
		expect(new Set([...first.authoringTaskIds, ...first.validationTaskIds]))
			.toEqual(new Set(value.corpus.tasks.map((task) => task.id)));
		expect(existsSync(improvementExperimentDesignPath(value.runsRoot, loopId))).toBe(true);

		const refs = improvementDesignCorpusRefs(first, value.stateRoot);
		expect(loadCorpus(refs.authoring).tasks.map((task) => task.id)).toEqual(first.authoringTaskIds);
		expect(loadCorpus(refs.validation).tasks.map((task) => task.id)).toEqual(first.validationTaskIds);
	});
});
