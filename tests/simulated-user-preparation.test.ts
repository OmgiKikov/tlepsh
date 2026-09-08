import { describe, expect, it } from "vitest";
import { SimulatedUserSpecSchema, MAX_TASK_TEXT_BYTES, TaskSchema, suiteHashOf } from "../src/manifest.js";
import { BuilderCorpusDraftTaskInputSchema, builderCorpusDraftTaskId } from "../src/application/builder-corpus-draft.js";
import { WorkbenchSubmitToolSchema } from "../src/builder/workbench-transport.js";
import { canonicalJson, hashValue } from "../src/provenance.js";

describe("simulated-user scenario preparation", () => {
	const legacy = { goal: "Find the next step", persona: "My account is 4412", maxTurns: 4, stopWhen: "A next step is explained" };
	const task = { input: "Help", simulatedUser: legacy, graders: [{ type: "turn_budget" as const, max: 4 }] };
	const approvedSpec = {
		projectId: "test", specId: `spec-${"0".repeat(64)}`,
		specContentHash: `sha256:${"1".repeat(64)}`, snapshotHash: `sha256:${"2".repeat(64)}`,
	};

	it("keeps absent-field legacy JSON, task ids and suite hashes unchanged", () => {
		expect(SimulatedUserSpecSchema.parse(legacy)).toStrictEqual(legacy);
		expect(SimulatedUserSpecSchema.parse(legacy)).not.toHaveProperty("knownFacts");
		const parsed = BuilderCorpusDraftTaskInputSchema.parse(task);
		expect(canonicalJson(parsed)).toBe(canonicalJson(task));
		expect(builderCorpusDraftTaskId(approvedSpec, parsed))
			.toBe(`task-${hashValue({ schemaVersion: 2, approvedSpec, task }).slice("sha256:".length)}`);
		const stored = { id: "legacy", ...task };
		expect(suiteHashOf([TaskSchema.parse(stored)], [], null, null)).toBe(suiteHashOf([stored], [], null, null));
	});

	it("round-trips explicit facts without normalization and changes measurement identity", () => {
		const facts = "  Account 4412.\nAlready restarted the router.  ";
		const withFacts = { ...task, simulatedUser: { ...legacy, knownFacts: facts } };
		const parsed = BuilderCorpusDraftTaskInputSchema.parse(JSON.parse(JSON.stringify(withFacts)));
		expect(parsed.simulatedUser?.knownFacts).toBe(facts);
		expect(builderCorpusDraftTaskId(approvedSpec, parsed)).not.toBe(builderCorpusDraftTaskId(approvedSpec, task));
		expect(suiteHashOf([{ id: "same", ...parsed }], [], null, null))
			.not.toBe(suiteHashOf([{ id: "same", ...task }], [], null, null));
	});

	it("bounds known facts in UTF-8 bytes and rejects blank/non-text facts", () => {
		for (const knownFacts of ["", " \n\t", null, [], {}, "x".repeat(MAX_TASK_TEXT_BYTES + 1), "\u00e9".repeat(MAX_TASK_TEXT_BYTES / 2 + 1)]) {
			expect(SimulatedUserSpecSchema.safeParse({ ...legacy, knownFacts }).success).toBe(false);
		}
		expect(SimulatedUserSpecSchema.safeParse({ ...legacy, knownFacts: "\u00e9".repeat(MAX_TASK_TEXT_BYTES / 2) }).success).toBe(true);
		expect(() => BuilderCorpusDraftTaskInputSchema.parse({
			...task, simulatedUser: { ...legacy, knownFacts: "Account 4412" }, messages: [{ role: "user", content: "Help" }],
		})).toThrow(/messages or simulatedUser, never both/);
	});

	it("exposes the facts field and authoring limits through the existing model tool schema", () => {
		const schema = JSON.stringify(WorkbenchSubmitToolSchema.parameters);
		expect(schema).toContain('"knownFacts"');
		expect(schema).toContain('"knownFactsColumn"');
		expect(schema).toContain("Never copy hidden world.state");
		expect(schema).toContain("not proven real-user behaviour");
	});
});
