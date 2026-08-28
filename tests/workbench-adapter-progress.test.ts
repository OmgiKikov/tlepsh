import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { createBuilderWorkbenchTools } from "../src/builder/workbench-adapter.js";
import type { RunEvent } from "../src/run-events.js";
import type { AhdeWorkbench } from "../src/workbench/workbench.js";

const progressEvent: RunEvent = {
	type: "assistant_delta",
	at: "2026-08-28T12:00:00.000Z",
	run: {
		evalRunId: "erun_development",
		runId: "run_development",
		taskId: "task-development",
		repetitionIndex: 0,
		ordinal: 1,
		total: 1,
	},
	delta: "development-live-canary",
	truncated: false,
};

describe("Workbench natural-language run progress", () => {
	it.each([
		{ kind: "run-current", repetitions: 1, reason: "Check routing" },
		{ kind: "run-eval", repetitions: 1, reason: "Run selected evaluation" },
		{ kind: "verify-candidate", repetitions: 1, reason: "Verify selected candidate" },
	] as const)("renders $kind live Target text only in host UI and never in the Builder tool result", async (input) => {
		const decide = vi.fn(async (_input, _gate, execution) => {
			execution?.onRunEvent?.(progressEvent);
			return {
				message: "Development evaluation completed.",
				result: { evalRunId: "erun_development" },
				view: { stage: "diagnosis-ready" },
			};
		});
		const workbench = { decide } as unknown as AhdeWorkbench;
		const tool = createBuilderWorkbenchTools(workbench, () => "local:test")
			.find((candidate) => candidate.name === "ahde_workbench_decide");
		if (!tool) throw new Error("missing ahde_workbench_decide");

		const confirm = vi.fn(async () => true);
		const setStatus = vi.fn();
		const setWidget = vi.fn();
		const onUpdate = vi.fn();
		const context = {
			hasUI: true,
			mode: "tui",
			ui: {
				confirm,
				select: vi.fn(async () => undefined),
				notify: vi.fn(),
				setStatus,
				setWidget,
			},
		} as unknown as ExtensionContext;

		const result = await tool.execute(
			"call-run",
			input,
			undefined,
			onUpdate,
			context,
		);

		expect(decide).toHaveBeenCalledWith(
			expect.objectContaining({ kind: input.kind }),
			expect.any(Object),
			expect.objectContaining({ onRunEvent: expect.any(Function) }),
		);
		expect(JSON.stringify(result)).not.toContain("development-live-canary");
		expect(onUpdate).not.toHaveBeenCalled();
		expect(setWidget.mock.calls.some(([, content]) => (
			Array.isArray(content) && content.join("\n").includes("development-live-canary")
		))).toBe(true);
		expect(setStatus).toHaveBeenLastCalledWith("ahde-run-progress", undefined);
		expect(setWidget).toHaveBeenLastCalledWith("ahde-run-progress", undefined);
	});
});
