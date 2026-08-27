import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BuilderCorpusDraftSchema,
	createBuilderCorpusDraft,
	listBuilderCorpusDrafts,
	loadBuilderCorpusDraft,
	reviseBuilderCorpusDraft,
} from "../src/application/builder-corpus-draft.js";
import { loadApprovedSpec, saveSpecSnapshot, type AgentSpec, type ApprovedSpecReference } from "../src/spec.js";
import { writeJsonArtifact } from "../src/storage/artifacts.js";

const NOW = "2026-08-26T16:00:00.000Z";
const LATER = "2026-08-26T17:00:00.000Z";
const roots: string[] = [];

function root(): string {
	const path = mkdtempSync(join(tmpdir(), "ahde-builder-corpus-draft-"));
	roots.push(path);
	return path;
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function spec(purpose = "Answer policy questions from approved evidence."): AgentSpec {
	return {
		schemaVersion: 1,
		title: "Policy assistant",
		purpose,
		users: ["Support operators"],
		jobs: ["Answer policy questions"],
		inputs: ["A policy question"],
		allowedActions: ["Read local policy documents"],
		successCriteria: ["Answer contains the applicable policy"],
		constraints: ["Never invent a policy"],
		openQuestions: [],
	};
}

function approved(
	stateRoot: string,
	projectId = "policy",
	purpose?: string,
): ApprovedSpecReference {
	const snapshot = saveSpecSnapshot({
		stateRoot,
		projectId,
		status: "approved",
		spec: spec(purpose),
		sourceText: purpose ?? "A policy Q&A assistant",
		now: () => NOW,
	});
	return loadApprovedSpec({ stateRoot, projectId, specId: snapshot.id }).reference;
}

function task(input: string, expected: string) {
	return {
		input,
		graders: [{ type: "output_contains" as const, text: expected }],
	};
}

describe("Builder Corpus Draft V2", () => {
	it("creates an immutable content-addressed draft with host-derived task ids", () => {
		const stateRoot = root();
		const approvedSpec = approved(stateRoot);
		const options = {
			stateRoot,
			approvedSpec,
			name: "  Policy development set  ",
			tasks: [
				task("What is the refund window?", "30 days"),
				task("What if the policy is absent?", "unknown"),
			],
			coverageNotes: ["Known-answer and missing-evidence paths"],
			revisionSummary: "Initial Builder Pi draft",
		};
		const first = createBuilderCorpusDraft(options, { now: () => NOW });
		const repeated = createBuilderCorpusDraft(options, { now: () => LATER });

		expect(first.draft).toMatchObject({
			schemaVersion: 2,
			kind: "builder-corpus-draft",
			projectId: "policy",
			approvedSpec,
			parentDraftId: null,
			name: "Policy development set",
			revisionSummary: "Initial Builder Pi draft",
			source: "builder-pi",
			createdAt: NOW,
		});
		expect(first.draft.id).toMatch(/^corpus-draft-[0-9a-f]{64}$/);
		expect(first.draft.tasks.map(({ id }) => id)).toEqual([
			expect.stringMatching(/^task-[0-9a-f]{64}$/),
			expect.stringMatching(/^task-[0-9a-f]{64}$/),
		]);
		expect(new Set(first.draft.tasks.map(({ id }) => id)).size).toBe(2);
		expect(first.draft.tasks[0]).toMatchObject({
			input: "What is the refund window?",
			graders: [{ type: "output_contains", text: "30 days", caseSensitive: false }],
		});
		expect(repeated).toEqual(first);
		expect(loadBuilderCorpusDraft(stateRoot, "policy", first.draft.id)).toEqual(first.draft);
		expect(listBuilderCorpusDrafts(stateRoot, "policy")).toEqual([first.draft]);
		expect(existsSync(first.path)).toBe(true);
		expect(() => writeJsonArtifact(
			first.path,
			BuilderCorpusDraftSchema,
			first.draft,
			{ immutable: true },
		)).toThrow(/immutable write refused/);
	});

	it("publishes revisions through add, replace, remove, rename, and set-notes operations", () => {
		const stateRoot = root();
		const approvedSpec = approved(stateRoot);
		const initial = createBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			name: "Policy cases",
			tasks: [task("Question A", "A"), task("Question B", "B")],
			coverageNotes: ["Happy paths"],
			revisionSummary: "Initial draft",
		}, { now: () => NOW });
		const [firstTask, secondTask] = initial.draft.tasks;
		if (!firstTask || !secondTask) throw new Error("fixture tasks missing");

		const revised = reviseBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			parentDraftId: initial.draft.id,
			operations: [
				{ type: "rename", name: "Policy regression cases" },
				{ type: "set-notes", coverageNotes: ["Happy paths", "Adversarial absence"] },
				{ type: "replace", taskId: firstTask.id, task: task("Question A, clarified", "A") },
				{ type: "remove", taskId: secondTask.id },
				{ type: "add", task: task("Question C", "unknown") },
			],
			revisionSummary: "Clarify A, replace B with missing-evidence coverage",
		}, { now: () => LATER });

		expect(revised.draft.id).not.toBe(initial.draft.id);
		expect(revised.draft.parentDraftId).toBe(initial.draft.id);
		expect(revised.draft.name).toBe("Policy regression cases");
		expect(revised.draft.coverageNotes).toEqual(["Happy paths", "Adversarial absence"]);
		expect(revised.draft.tasks.map(({ input }) => input)).toEqual(["Question A, clarified", "Question C"]);
		expect(revised.draft.tasks.map(({ id }) => id)).not.toContain(firstTask.id);
		expect(revised.draft.tasks.map(({ id }) => id)).not.toContain(secondTask.id);
		expect(loadBuilderCorpusDraft(stateRoot, "policy", initial.draft.id)).toEqual(initial.draft);
		expect(listBuilderCorpusDrafts(stateRoot, "policy")).toEqual([revised.draft, initial.draft]);

		const metadataOnly = reviseBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			parentDraftId: revised.draft.id,
			operations: [{ type: "rename", name: "Policy regression suite" }],
			revisionSummary: "Rename for publication",
		}, { now: () => "2026-08-26T18:00:00.000Z" });
		expect(metadataOnly.draft.tasks.map(({ id }) => id)).toEqual(revised.draft.tasks.map(({ id }) => id));
	});

	it("binds creation and every revision to the exact stored approved Spec", () => {
		const stateRoot = root();
		const firstSpec = approved(stateRoot);
		const initial = createBuilderCorpusDraft({
			stateRoot,
			approvedSpec: firstSpec,
			name: "Policy cases",
			tasks: [task("Question A", "A")],
			revisionSummary: "Initial draft",
		});
		const secondSpec = approved(stateRoot, "policy", "Answer only billing policy questions.");

		expect(() => reviseBuilderCorpusDraft({
			stateRoot,
			approvedSpec: secondSpec,
			parentDraftId: initial.draft.id,
			operations: [{ type: "rename", name: "Wrong lineage" }],
			revisionSummary: "Attempt to cross Spec lineage",
		})).toThrow(/different approved Spec/);

		expect(() => createBuilderCorpusDraft({
			stateRoot,
			approvedSpec: { ...firstSpec, snapshotHash: `sha256:${"0".repeat(64)}` },
			name: "Tampered reference",
			tasks: [task("Question A", "A")],
			revisionSummary: "Must fail",
		})).toThrow(/does not match the exact stored snapshot/);
	});

	it("rejects malformed, duplicate, missing, and oversized Builder input", () => {
		const stateRoot = root();
		const approvedSpec = approved(stateRoot);
		const base = {
			stateRoot,
			approvedSpec,
			name: "Policy cases",
			revisionSummary: "Initial draft",
		};

		expect(() => createBuilderCorpusDraft({ ...base, tasks: [] })).toThrow(/at least 1|>=1/);
		expect(() => createBuilderCorpusDraft({
			...base,
			tasks: Array.from({ length: 101 }, (_, index) => task(`Question ${index}`, "answer")),
		})).toThrow(/<=100|at most 100/);
		expect(() => createBuilderCorpusDraft({
			...base,
			tasks: [task("Question A", "A"), task("Question A", "A")],
		})).toThrow(/duplicate task content/);
		expect(() => createBuilderCorpusDraft({
			...base,
			tasks: [{ id: "builder-supplied", ...task("Question A", "A") }],
		})).toThrow(/Unrecognized key.*id/);
		expect(() => createBuilderCorpusDraft({
			...base,
			tasks: [task("Question A", "A")],
			coverageNotes: ["x".repeat(1_001)],
		})).toThrow(/<=1000|at most 1000/);

		const oversized = Array.from({ length: 100 }, (_, index) =>
			task(`${index}:${"x".repeat(22_000)}`, String(index)));
		expect(() => createBuilderCorpusDraft({ ...base, tasks: oversized })).toThrow(/draft content exceeds/);

		const initial = createBuilderCorpusDraft({ ...base, tasks: [task("Question A", "A")] });
		expect(() => reviseBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			parentDraftId: initial.draft.id,
			operations: [],
			revisionSummary: "No operations",
		})).toThrow(/at least 1|>=1/);
		expect(() => reviseBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			parentDraftId: initial.draft.id,
			operations: [{ type: "remove", taskId: initial.draft.tasks[0]!.id }],
			revisionSummary: "Cannot remove every task",
		})).toThrow(/at least 1|>=1/);
		expect(() => reviseBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			parentDraftId: initial.draft.id,
			operations: [{ type: "replace", taskId: `task-${"0".repeat(64)}`, task: task("B", "B") }],
			revisionSummary: "Unknown replacement",
		})).toThrow(/replace references unknown task/);
	});

	it("rejects path traversal, symlinked state components, symlinked artifacts, and tampering", () => {
		const stateRoot = root();
		const approvedSpec = approved(stateRoot);
		expect(() => listBuilderCorpusDrafts(stateRoot, "../policy")).toThrow(/safe path segment/);

		const outside = root();
		const draftDirectory = join(stateRoot, "projects", "policy", "builder-corpus-drafts");
		symlinkSync(outside, draftDirectory, "dir");
		expect(() => createBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			name: "Policy cases",
			tasks: [task("Question A", "A")],
			revisionSummary: "Initial draft",
		})).toThrow(/regular non-symlink directory/);
		expect(existsSync(join(outside, "corpus-draft"))).toBe(false);
		rmSync(draftDirectory);

		const created = createBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			name: "Policy cases",
			tasks: [task("Question A", "A")],
			revisionSummary: "Initial draft",
		});
		const parsed = JSON.parse(readFileSync(created.path, "utf8")) as Record<string, unknown>;
		writeFileSync(created.path, `${JSON.stringify({ ...parsed, name: "tampered" })}\n`, "utf8");
		expect(() => loadBuilderCorpusDraft(stateRoot, "policy", created.draft.id)).toThrow(/id does not match its content/);

		const symlinkTarget = join(outside, "draft.json");
		writeFileSync(symlinkTarget, `${JSON.stringify(created.draft)}\n`, "utf8");
		rmSync(created.path);
		mkdirSync(dirname(created.path), { recursive: true });
		symlinkSync(symlinkTarget, created.path);
		expect(() => loadBuilderCorpusDraft(stateRoot, "policy", created.draft.id)).toThrow(/non-symlink file/);
	});
});
