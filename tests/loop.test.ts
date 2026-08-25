import { describe, expect, it } from "vitest";
import { selectSmokeTaskId } from "../src/loop.js";
import type { ResolvedTask } from "../src/manifest.js";

function task(id: string, type: "tool_called" | "output_contains" | "judge"): ResolvedTask {
	return {
		id,
		input: id,
		effectiveGraders:
			type === "tool_called"
				? [{ type, tool: "bash", argsContains: "check" }]
				: type === "judge"
					? [{ type, rubric: "по существу" }]
					: [{ type, text: "ok", caseSensitive: false }],
	};
}

describe("selectSmokeTaskId", () => {
	it("prefers a tool-free task over the first complex task", () => {
		expect(selectSmokeTaskId([task("complex", "tool_called"), task("simple", "output_contains")])).toBe("simple");
	});

	it("skips judge tasks: smoke stays a zero-extra-cost infrastructure check", () => {
		expect(selectSmokeTaskId([task("judged", "judge"), task("simple", "output_contains")])).toBe("simple");
	});

	it("falls back to the first task when every task uses tools", () => {
		expect(selectSmokeTaskId([task("first", "tool_called"), task("second", "tool_called")])).toBe("first");
	});

	it("returns undefined for an empty suite", () => {
		expect(selectSmokeTaskId([])).toBeUndefined();
	});
});
