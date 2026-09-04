import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BuilderCorpusDraftSchema,
	BuilderCorpusDraftTaskInputSchema,
	BuilderCorpusDraftTaskProvenanceSchema,
	builderCorpusDraftTaskId,
	createBuilderCorpusDraft,
	loadBuilderCorpusDraft,
	reviseBuilderCorpusDraft,
} from "../src/application/builder-corpus-draft.js";
import { loadApprovedSpec, saveSpecSnapshot } from "../src/spec.js";

const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "ahde-draft-provenance-"));
	roots.push(value);
	return value;
}

afterEach(() => {
	for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function approved(stateRoot: string) {
	const snapshot = saveSpecSnapshot({
		stateRoot,
		projectId: "support-agent",
		status: "approved",
		spec: {
			schemaVersion: 1 as const,
			title: "Support agent",
			purpose: "Resolve support questions.",
			users: ["Customers"],
			jobs: ["Resolve an issue"],
			inputs: ["A support request"],
			allowedActions: ["Read account state"],
			successCriteria: ["The issue is resolved"],
			constraints: ["Do not invent account state"],
			openQuestions: [],
		},
		sourceText: "Support agent",
	});
	return loadApprovedSpec({ stateRoot, projectId: "support-agent", specId: snapshot.id }).reference;
}

const task = (input: string) => ({
	input,
	graders: [{ type: "output_contains" as const, text: "resolved" }],
});

const developmentSource = {
	corpusId: `corpus-${"2".repeat(64)}`,
	corpusHash: `sha256:${"3".repeat(64)}`,
	evalRunId: "erun_source",
	evalRunHash: `sha256:${"4".repeat(64)}`,
	runId: "run_source",
	runHash: `sha256:${"5".repeat(64)}`,
	tracePath: "session.jsonl" as const,
	traceSha256: `sha256:${"6".repeat(64)}`,
	sourceTaskId: "source-task",
	sourceTaskHash: `sha256:${"7".repeat(64)}`,
};

describe("Builder corpus draft failure provenance compatibility", () => {
	it("continues to read and write the legacy v2 development-failure member", () => {
		const stateRoot = root();
		const spec = approved(stateRoot);
		const initial = createBuilderCorpusDraft({
			stateRoot,
			approvedSpec: spec,
			name: "Regressions",
			tasks: [task("Existing case")],
			revisionSummary: "Initial draft",
		});
		const added = BuilderCorpusDraftTaskInputSchema.parse(task("Development failure"));
		const taskId = builderCorpusDraftTaskId(spec, added);
		const revised = reviseBuilderCorpusDraft({
			stateRoot,
			approvedSpec: spec,
			parentDraftId: initial.draft.id,
			operations: [{ type: "add", task: added }],
			verifiedTaskProvenance: [{
				operationIndex: 0,
				provenance: { kind: "development-failure", taskId, source: developmentSource },
			}],
			revisionSummary: "Keep an observed development regression",
		});

		expect(revised.draft.schemaVersion).toBe(2);
		expect(BuilderCorpusDraftSchema.parse(revised.draft)).toEqual(revised.draft);
		expect(loadBuilderCorpusDraft(stateRoot, "support-agent", revised.draft.id)).toEqual(revised.draft);
	});

	it("writes the explicit versioned production-failure member only in v3 drafts", () => {
		const stateRoot = root();
		const spec = approved(stateRoot);
		const initial = createBuilderCorpusDraft({
			stateRoot,
			approvedSpec: spec,
			name: "Regressions",
			tasks: [task("Existing case")],
			revisionSummary: "Initial draft",
		});
		const added = BuilderCorpusDraftTaskInputSchema.parse(task("Imported production failure"));
		const taskId = builderCorpusDraftTaskId(spec, added);
		const provenance = BuilderCorpusDraftTaskProvenanceSchema.parse({
			kind: "production-failure",
			taskId,
			source: {
				schemaVersion: 1,
				failureId: `failure-${"1".repeat(64)}`,
				failureHash: `sha256:${"2".repeat(64)}`,
				source: {
					kind: "real",
					path: "imports/incident.jsonl",
					sha256: `sha256:${"3".repeat(64)}`,
				},
				redactedSha256: `sha256:${"4".repeat(64)}`,
				importedAgainst: { id: "support-agent", gitSha: "a".repeat(40) },
				targetClaim: { id: "external-alias", gitSha: "release-42" },
				toolEvidence: { authority: "reported", eventCount: 2, omittedCount: 0 },
			},
		});
		const revised = reviseBuilderCorpusDraft({
			stateRoot,
			approvedSpec: spec,
			parentDraftId: initial.draft.id,
			operations: [{ type: "add", task: added }],
			verifiedTaskProvenance: [{ operationIndex: 0, provenance }],
			revisionSummary: "Add one reviewed production regression",
		});

		expect(revised.draft.schemaVersion).toBe(3);
		expect(revised.draft.taskProvenance).toEqual([provenance]);
		expect(loadBuilderCorpusDraft(stateRoot, "support-agent", revised.draft.id)).toEqual(revised.draft);

		const disguisedAsV2 = { ...revised.draft, schemaVersion: 2 };
		const parsed = BuilderCorpusDraftSchema.safeParse(disguisedAsV2);
		expect(parsed.success).toBe(false);
		if (!parsed.success) {
			expect(parsed.error.message).toContain("production-failure provenance requires Builder corpus draft schemaVersion 3");
		}
	});
});
