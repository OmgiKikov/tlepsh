import { describe, expect, it, vi } from "vitest";
import { candidateCases } from "../src/workbench/candidate-cases.js";
import { loadPublicEvalRun } from "../src/evidence/model.js";
import { compareVerifiedEvalRuns } from "../src/compare.js";
import { taskInputPreviews } from "../src/application/run-explanation.js";

vi.mock("../src/evidence/model.js", async (original) => ({ ...await original<object>(), loadPublicEvalRun: vi.fn() }));
vi.mock("../src/compare.js", async (original) => ({ ...await original<object>(), compareVerifiedEvalRuns: vi.fn() }));
vi.mock("../src/application/run-explanation.js", async (original) => ({ ...await original<object>(), taskInputPreviews: vi.fn() }));

describe("candidate case projection", () => {
	it("counts the whole comparison and reads previews for selected rows, including a late regression", () => {
		const rows = Array.from({ length: 73 }, (_, index) => ({
			taskId: `case-${String(index + 1).padStart(3, "0")}`, aPass: 1, aTotal: 1, aScore: 1,
			bPass: index === 72 ? 0 : 1, bTotal: 1, bScore: index === 72 ? 0 : 1, scoreDelta: index === 72 ? -1 : 0,
		}));
		vi.mocked(loadPublicEvalRun).mockReturnValue({ runs: rows } as unknown as ReturnType<typeof loadPublicEvalRun>);
		vi.mocked(compareVerifiedEvalRuns).mockReturnValue({ rows, excluded: [] } as unknown as ReturnType<typeof compareVerifiedEvalRuns>);
		vi.mocked(taskInputPreviews).mockImplementation((_root, runs, limit) => new Map(runs.slice(0, limit).map((run) => [run.taskId, `Input for ${run.taskId}`])));
		const arms = { baseline: { evalRunId: "erun-a" }, candidate: { evalRunId: "erun-b" } };
		const first = candidateCases("runs", arms);
		expect(first).toMatchObject({ casesTotal: 73, casesOffset: 0 });
		expect(first.cases).toHaveLength(60);
		expect(first.cases?.[0]).toMatchObject({ taskId: "case-073", input: "Input for case-073", scoreDelta: -1 });
		const last = candidateCases("runs", arms, 60);
		expect(last).toMatchObject({ casesTotal: 73, casesOffset: 60 });
		expect(last.cases).toHaveLength(13);
		expect(last.cases?.every((entry) => entry.input === `Input for ${entry.taskId}`)).toBe(true);
		expect(new Set([...first.cases!, ...last.cases!].map((entry) => entry.taskId)).size).toBe(73);
		expect(candidateCases("runs", arms, 73)).toEqual({ cases: [], casesTotal: 73, casesOffset: 73 });
		vi.mocked(loadPublicEvalRun).mockImplementation(() => { throw new Error("private or unreadable arm"); });
		expect(candidateCases("runs", arms)).toEqual({ cases: null });
	});
});
