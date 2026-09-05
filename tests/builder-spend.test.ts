import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuilderSpendReader } from "../src/builder/spend.js";
import { readEvalRunIndex, writeEvalRun } from "../src/eval.js";
import { writeExplorerFixture, type ArmCase } from "./helpers/evidence-fixture.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(costs: readonly (number | null)[]) {
	const data = writeExplorerFixture(() => costs.map((costUsd, index): ArmCase => ({
		taskId: `task_${index}`, input: "Question", answer: "Answer", calledTool: false,
		graders: [{ name: "answer", type: "output_contains", passed: true, score: 1, reason: "matched" }],
		costUsd,
	})));
	roots.push(data.runsRoot);
	return data;
}

describe("Builder recorded spend", () => {
	it("retains measured zero and sums complete development measurements without opening sealed runs", () => {
		const data = fixture([0, 0.2]);
		const reader = createBuilderSpendReader({ runsRoot: data.runsRoot });
		expect(reader.ofEvalRun(data.baselineEvalRunId)?.costUsd).toBe(0.2);
		expect(reader.ofEvalRun(data.sealedEvalRunId)).toBeNull();
		expect(reader.cycle()).toMatchObject({ costUsd: 0.4, evals: 2 });
	});

	it.each([[null, 0.2], [0.2, null]])("keeps mixed known and unknown member costs unknown: %j", (...costs) => {
		const data = fixture(costs);
		const reader = createBuilderSpendReader({ runsRoot: data.runsRoot });
		expect(reader.ofEvalRun(data.baselineEvalRunId)).toMatchObject({ runs: 2, costUsd: null });
		expect(reader.cycle()).toMatchObject({ costUsd: null, evals: 2 });
	});

	it("does not present an unreadable member's partial sum as the eval or cycle total", () => {
		const data = fixture([0.1, 0.2]);
		rmSync(join(data.runsRoot, "run_base_1", "run.json"));
		const reader = createBuilderSpendReader({ runsRoot: data.runsRoot });
		expect(reader.ofEvalRun(data.baselineEvalRunId)).toMatchObject({ runs: 2, costUsd: null, judgeCostUsd: null });
		expect(reader.cycle()).toMatchObject({ costUsd: null, judgeCostUsd: null });
	});

	it("does not turn the bounded scan into a complete cycle total", () => {
		const data = fixture([0.1]);
		const baseline = readEvalRunIndex(data.runsRoot, data.baselineEvalRunId);
		for (let index = 0; index < 40; index += 1) {
			writeEvalRun(data.runsRoot, { ...baseline, evalRunId: `erun_extra_${index}` });
		}
		const reader = createBuilderSpendReader({ runsRoot: data.runsRoot });
		expect(reader.cycle()).toMatchObject({ costUsd: null, judgeCostUsd: null });
	});
});
