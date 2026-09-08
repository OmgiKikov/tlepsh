import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BuilderCorpusDraftSchema,
	BuilderCorpusDraftTaskInputSchema,
	builderCorpusDraftTaskId,
	createBuilderCorpusDraft,
	listBuilderCorpusDrafts,
	loadBuilderCorpusDraft,
	reviseBuilderCorpusDraft,
} from "../src/application/builder-corpus-draft.js";
import { loadApprovedSpec, saveSpecSnapshot, type AgentSpec, type ApprovedSpecReference } from "../src/spec.js";
import { writeJsonArtifact } from "../src/storage/artifacts.js";
import { createCorpus, loadCorpus } from "../src/corpus.js";
import { importBuilderCorpusDraft } from "../src/application/builder-corpus-import.js";

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
	it("scores a simulated dialogue by its outcome, never by a judge alone", () => {
		const stateRoot = root();
		const approvedSpec = approved(stateRoot);
		const simulatedUser = { goal: "Get a technician booked", persona: "Terse", knownFacts: "Contract 3050.", maxTurns: 4 };
		const judgeOnly = { input: "Nothing works.", simulatedUser, graders: [{ type: "judge" as const, rubric: "The agent is polite." }] };
		const draft = (tasks: unknown[]) => createBuilderCorpusDraft({
			stateRoot, approvedSpec, name: "Dialogues", tasks, revisionSummary: "Simulated cases",
		}, { now: () => NOW });
		// Two models agreeing with each other is not an outcome.
		expect(() => draft([judgeOnly])).toThrow(/simulated-user case “Nothing works\.” is scored only by a judge; add a world\.expect or a deterministic grader/);
		// The world afterwards, or a deterministic read of the transcript, is.
		const worlded = draft([{ ...judgeOnly, world: { state: { tickets: [] }, expect: [{ path: "tickets.0.account", op: "equals", value: "3050" }] } }]);
		const deterministic = draft([{ ...judgeOnly, graders: [...judgeOnly.graders, { type: "tool_called" as const, tool: "create_ticket" }] }]);
		expect(worlded.draft.tasks).toHaveLength(1);
		expect(deterministic.draft.tasks).toHaveLength(1);
		// A revision cannot strip the outcome back out of it.
		expect(() => reviseBuilderCorpusDraft({
			stateRoot, approvedSpec, parentDraftId: deterministic.draft.id,
			operations: [{ type: "set-graders", taskId: deterministic.draft.tasks[0]!.id, graders: judgeOnly.graders }],
			revisionSummary: "Judge only",
		})).toThrow(/scored only by a judge/);
		// A scripted or single-turn case keeps its judge-only freedom: nothing is simulated there.
		expect(draft([{ input: "Nothing works.", graders: judgeOnly.graders }]).draft.tasks).toHaveLength(1);
	});

	it("preserves simulator facts through import, immutable revision and corpus JSONL serialization", () => {
		const stateRoot = root();
		const projectDir = root();
		const approvedSpec = approved(stateRoot);
		const simulatedUser = {
			goal: "Understand the account issue", persona: "Brief replies", knownFacts: "My account is 4412.", maxTurns: 4,
		};
		const world = { state: { privateReason: "BACKEND-ONLY" } };
		mkdirSync(join(projectDir, "imports"));
		writeFileSync(join(projectDir, "imports", "cases.jsonl"), JSON.stringify({
			id: "original", ...task("Help with my account", "next step"), simulatedUser, world,
		}));
		const imported = importBuilderCorpusDraft({
			stateRoot, projectDir, runsRoot: join(projectDir, "runs"), approvedSpec,
			sourcePath: "imports/cases.jsonl", name: "Reactive case", revisionSummary: "Import user facts",
		});
		expect(imported.draft.tasks[0]?.simulatedUser).toEqual(simulatedUser);
		const revised = reviseBuilderCorpusDraft({
			stateRoot, approvedSpec, parentDraftId: imported.draft.id,
			operations: [{ type: "set-graders", taskId: imported.draft.tasks[0]!.id, graders: [{ type: "turn_budget", max: 4 }] }],
			revisionSummary: "Change the check, not the scenario",
		});
		const loaded = loadBuilderCorpusDraft(stateRoot, "policy", revised.draft.id);
		expect(loaded.tasks[0]?.simulatedUser).toEqual(simulatedUser);
		expect(loaded.tasks[0]?.world).toEqual(world);
		expect(loadBuilderCorpusDraft(stateRoot, "policy", imported.draft.id)).toEqual(imported.draft);
		const corpus = createCorpus({ stateRoot, projectId: "policy", name: "Reviewed", visibility: "development", tasks: loaded.tasks });
		expect(loadCorpus({ stateRoot, projectId: "policy", corpusId: corpus.id }).tasks).toEqual(loaded.tasks);
	});

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

	/**
	 * A case's id is the content hash of the whole task under its approved Spec,
	 * and every screen, receipt and provenance row is addressed by it. Nothing
	 * time-shaped may ever enter that hash: a `createdAt`, an ordinal or an
	 * author would make the same case a different case on every publish and
	 * break the deduplication the draft depends on. This is the regression test
	 * that has to fail before anyone adds a field to the task schema.
	 */
	it("gives byte-identical task input the same id, whenever and wherever it is published", () => {
		const stateRoot = root();
		const approvedSpec = approved(stateRoot);
		const cases = [task("What is the refund window?", "30 days")];
		const first = createBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			name: "Policy cases",
			tasks: cases,
			revisionSummary: "Initial draft",
		}, { now: () => NOW });
		// A second draft, an hour later, under a different name and different
		// notes: nothing about a case but the case itself decides its id.
		const later = createBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			name: "Policy cases, second look",
			tasks: cases,
			coverageNotes: ["Written again from scratch"],
			revisionSummary: "Republished from the same words",
		}, { now: () => LATER });
		const id = first.draft.tasks[0]?.id;
		expect(id).toMatch(/^task-[0-9a-f]{64}$/);
		expect(later.draft.tasks[0]?.id).toBe(id);
		expect(later.draft.id).not.toBe(first.draft.id);
		// The published id is exactly what the host-side function computes, so a
		// caller can address a case before it has ever been written down.
		expect(builderCorpusDraftTaskId(approvedSpec, BuilderCorpusDraftTaskInputSchema.parse(cases[0]))).toBe(id);
		// Removed and written again, word for word, it comes back as the same case.
		const withoutIt = reviseBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			parentDraftId: first.draft.id,
			operations: [{ type: "add", task: task("Question B", "B") }, { type: "remove", taskId: id ?? "", reason: "the refund rule it cites was never approved" }],
			revisionSummary: "Drop the refund case",
		}, { now: () => LATER });
		expect(withoutIt.draft.tasks.map(({ id: each }) => each)).not.toContain(id);
		const readded = reviseBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			parentDraftId: withoutIt.draft.id,
			operations: [{ type: "add", task: cases[0] }],
			revisionSummary: "Put the refund case back",
		}, { now: () => "2026-08-26T18:00:00.000Z" });
		expect(readded.draft.tasks.map(({ id: each }) => each)).toContain(id);
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
				{ type: "remove", taskId: secondTask.id, reason: "its expected answer contradicts the Spec" },
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

	it("edits graders without replacing the task input and preserves verified failure provenance", () => {
		const stateRoot = root();
		const approvedSpec = approved(stateRoot);
		const initial = createBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			name: "Policy cases",
			tasks: [task("Question A", "A")],
			revisionSummary: "Initial draft",
		});
		const regressionTask = BuilderCorpusDraftTaskInputSchema.parse(
			task("Question A after the observed failure", "A with citation"),
		);
		const regressionTaskId = builderCorpusDraftTaskId(approvedSpec, regressionTask);
		const evidenced = reviseBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			parentDraftId: initial.draft.id,
			operations: [{ type: "add", task: regressionTask }],
			verifiedTaskProvenance: [{
				operationIndex: 0,
				provenance: {
					kind: "development-failure",
					taskId: regressionTaskId,
					source: {
						corpusId: `corpus-${"2".repeat(64)}`,
						corpusHash: `sha256:${"3".repeat(64)}`,
						evalRunId: "erun_source",
						evalRunHash: `sha256:${"4".repeat(64)}`,
						runId: "run_source",
						runHash: `sha256:${"5".repeat(64)}`,
						tracePath: "session.jsonl",
						traceSha256: `sha256:${"6".repeat(64)}`,
						sourceTaskId: initial.draft.tasks[0]!.id,
						sourceTaskHash: `sha256:${"7".repeat(64)}`,
					},
				},
			}],
			revisionSummary: "Add evidenced regression",
		});
		const storedRegression = evidenced.draft.tasks.find((candidate) => candidate.input === regressionTask.input)!;
		expect(storedRegression.id).toBe(regressionTaskId);
		expect(evidenced.draft.taskProvenance).toEqual([
			expect.objectContaining({ taskId: regressionTaskId, kind: "development-failure" }),
		]);

		const regraded = reviseBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			parentDraftId: evidenced.draft.id,
			operations: [{
				type: "set-graders",
				taskId: regressionTaskId,
				graders: [{ type: "output_matches", pattern: "citation:[^\\n]+" }],
			}],
			revisionSummary: "Tighten the regression grader",
		});
		const updated = regraded.draft.tasks.find((candidate) => candidate.input === regressionTask.input)!;
		expect(updated.input).toBe(regressionTask.input);
		expect(updated.id).not.toBe(regressionTaskId);
		expect(updated.graders).toEqual([{ type: "output_matches", pattern: "citation:[^\\n]+" }]);
		expect(regraded.draft.taskProvenance).toEqual([
			expect.objectContaining({ taskId: updated.id, kind: "development-failure" }),
		]);
		const graderAdded = reviseBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			parentDraftId: regraded.draft.id,
			operations: [{
				type: "grader.add",
				taskId: updated.id,
				grader: { type: "output_contains", text: "policy" },
			}],
			revisionSummary: "Add an independent regression grader",
		});
		const addedTask = graderAdded.draft.tasks.find((candidate) => candidate.input === regressionTask.input)!;
		expect(addedTask.graders).toHaveLength(2);
		const graderUpdated = reviseBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			parentDraftId: graderAdded.draft.id,
			operations: [{
				type: "grader.update",
				taskId: addedTask.id,
				graderIndex: 1,
				grader: { type: "output_contains", text: "verified policy", caseSensitive: true },
			}],
			revisionSummary: "Update one grader without replacing the array",
		});
		const graderUpdatedTask = graderUpdated.draft.tasks.find((candidate) => candidate.input === regressionTask.input)!;
		expect(graderUpdatedTask.graders[1]).toEqual({
			type: "output_contains",
			text: "verified policy",
			caseSensitive: true,
		});
		const graderRemoved = reviseBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			parentDraftId: graderUpdated.draft.id,
			operations: [{
				type: "grader.remove",
				taskId: graderUpdatedTask.id,
				graderIndex: 0,
			}],
			revisionSummary: "Remove one grader without replacing the task",
		});
		const graderRemovedTask = graderRemoved.draft.tasks.find((candidate) => candidate.input === regressionTask.input)!;
		expect(graderRemovedTask.graders).toEqual([{
			type: "output_contains",
			text: "verified policy",
			caseSensitive: true,
		}]);
		expect(graderRemoved.draft.taskProvenance).toEqual([
			expect.objectContaining({ taskId: graderRemovedTask.id, kind: "development-failure" }),
		]);

		const provenance = evidenced.draft.taskProvenance![0]!;
		const rebuilt = reviseBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			parentDraftId: evidenced.draft.id,
			operations: [
				{ type: "remove", taskId: regressionTaskId, reason: "rebuilt in operation order" },
				{ type: "add", task: regressionTask },
			],
			revisionSummary: "Rebuild the evidenced task in operation order",
		});
		expect(rebuilt.draft.taskProvenance).toEqual([provenance]);

		const operationBound = reviseBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			parentDraftId: initial.draft.id,
			operations: [
				{ type: "add", task: regressionTask },
				{
					type: "set-graders",
					taskId: regressionTaskId,
					graders: [{ type: "output_contains", text: "ordinary variant" }],
				},
				{ type: "add", task: regressionTask },
			],
			verifiedTaskProvenance: [{ operationIndex: 2, provenance }],
			revisionSummary: "Bind evidence only to its exact add operation",
		});
		expect(operationBound.draft.taskProvenance).toEqual([provenance]);
		expect(operationBound.draft.tasks.find((candidate) => candidate.id === regressionTaskId)).toBeDefined();

		const replacedIdentically = reviseBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			parentDraftId: initial.draft.id,
			operations: [
				{ type: "add", task: regressionTask },
				{ type: "replace", taskId: regressionTaskId, task: regressionTask },
			],
			verifiedTaskProvenance: [{ operationIndex: 0, provenance }],
			revisionSummary: "Retain evidence when identical content survives",
		});
		expect(replacedIdentically.draft.taskProvenance).toEqual([provenance]);
		expect(() => reviseBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			parentDraftId: initial.draft.id,
			operations: [{ type: "rename", name: "No matching regression" }],
			verifiedTaskProvenance: [{ operationIndex: 0, provenance }],
			revisionSummary: "Reject unattached host provenance",
		})).toThrow(/must bind an add operation/);
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
			operations: [{ type: "remove", taskId: initial.draft.tasks[0]!.id, reason: "the only case" }],
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
		unlinkSync(draftDirectory);

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

/**
 * A basket is the Spec's jobs crossed with difficulty, and every case says
 * where it came from. Both labels are checked against something outside the
 * draft, so neither can be a word the model made up.
 */
describe("coverage, sources and exclusions", () => {
	const coverage = { job: "Answer policy questions", difficulty: "direct" as const };

	function labelled(input: string, source?: unknown) {
		return { ...task(input, "policy"), coverage, ...(source ? { source } : {}) };
	}

	it("keeps the cell and the citation on the case, through a revision and into a corpus", () => {
		const stateRoot = root();
		const approvedSpec = approved(stateRoot);
		const source = { kind: "kb" as const, path: "data/kb/refunds.md", sha256: `sha256:${"a".repeat(64)}` };
		const seen: unknown[] = [];
		const created = createBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			name: "Labelled",
			tasks: [{ ...labelled("How long do refunds take?", source), coverage: { ...coverage, difficulty: "no-answer", state: "no policy" } }],
			verifySource: (value) => void seen.push(value),
			revisionSummary: "First cells",
		}, { now: () => NOW });
		expect(seen).toEqual([source]);
		expect(created.draft.tasks[0]?.coverage).toEqual({ ...coverage, difficulty: "no-answer", state: "no policy" });
		expect(created.draft.tasks[0]?.source).toEqual(source);
		const revised = reviseBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			parentDraftId: created.draft.id,
			operations: [{ type: "add", task: labelled("Which policy applies to a late refund?", { kind: "spec" }) }],
			revisionSummary: "One more cell",
		}, { now: () => LATER });
		const loaded = loadBuilderCorpusDraft(stateRoot, "policy", revised.draft.id);
		expect(loaded.tasks.map((one) => one.coverage?.difficulty)).toEqual(["no-answer", "direct"]);
		expect(loaded.tasks[1]?.source).toEqual({ kind: "spec" });
		const corpus = createCorpus({ stateRoot, projectId: "policy", name: "Published", visibility: "development", tasks: loaded.tasks });
		expect(loadCorpus({ stateRoot, projectId: "policy", corpusId: corpus.id }).tasks).toEqual(loaded.tasks);
	});

	it("refuses a job the approved Spec does not name, and lists the ones it does", () => {
		const stateRoot = root();
		const approvedSpec = approved(stateRoot);
		expect(() => createBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			name: "Wrong job",
			tasks: [{ ...task("Question A", "A"), coverage: { job: "answer policy questions", difficulty: "direct" as const } }],
			revisionSummary: "Paraphrased job",
		})).toThrow(/coverage\.job "answer policy questions" is not a job of the approved Spec; use one of: "Answer policy questions"/);
	});

	it("refuses the host-minted source kinds from a Builder, on create and on revision", () => {
		const stateRoot = root();
		const approvedSpec = approved(stateRoot);
		const created = createBuilderCorpusDraft({
			stateRoot, approvedSpec, name: "Sources", tasks: [task("Question A", "A")], revisionSummary: "Plain",
		}, { now: () => NOW });
		for (const source of [{ kind: "production", traceId: "trace-1" }, { kind: "generated", generator: "judge" }]) {
			expect(() => createBuilderCorpusDraft({
				stateRoot, approvedSpec, name: "Minted", tasks: [{ ...task("Question B", "B"), source }], revisionSummary: "Minted",
			})).toThrow(/host-minted and cannot be written by a Builder/);
			expect(() => reviseBuilderCorpusDraft({
				stateRoot,
				approvedSpec,
				parentDraftId: created.draft.id,
				operations: [{ type: "add", task: { ...task("Question C", "C"), source } }],
				revisionSummary: "Minted",
			})).toThrow(/host-minted and cannot be written by a Builder/);
		}
	});

	it("records why every excluded case left, and carries the record down the lineage", () => {
		const stateRoot = root();
		const approvedSpec = approved(stateRoot);
		const created = createBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			name: "Three cases",
			tasks: [task("Question A", "A"), task("Question B", "B"), task("Question C", "C")],
			revisionSummary: "Initial",
		}, { now: () => NOW });
		// No reason, no exclusion: a removal is the one operation that loses
		// evidence, so it is the one that has to say why.
		expect(() => reviseBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			parentDraftId: created.draft.id,
			operations: [{ type: "remove", taskId: created.draft.tasks[0]!.id }],
			revisionSummary: "Silent removal",
		})).toThrow();
		const first = reviseBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			parentDraftId: created.draft.id,
			operations: [{ type: "remove", taskId: created.draft.tasks[0]!.id, reason: "its expected answer names a rule the Spec never states" }],
			revisionSummary: "Exclude the contradictory case",
		}, { now: () => NOW });
		expect(first.draft.exclusions).toEqual([{
			taskId: created.draft.tasks[0]!.id,
			reason: "its expected answer names a rule the Spec never states",
			at: NOW,
		}]);
		const second = reviseBuilderCorpusDraft({
			stateRoot,
			approvedSpec,
			parentDraftId: first.draft.id,
			operations: [{ type: "remove", taskId: created.draft.tasks[1]!.id, reason: "duplicate of the case above, reworded" }],
			revisionSummary: "Exclude the duplicate",
		}, { now: () => LATER });
		expect(second.draft.exclusions?.map((exclusion) => exclusion.reason)).toEqual([
			"its expected answer names a rule the Spec never states",
			"duplicate of the case above, reworded",
		]);
		expect(loadBuilderCorpusDraft(stateRoot, "policy", second.draft.id).exclusions).toEqual(second.draft.exclusions);
		// A draft that never excluded anything still hashes the way it always did.
		expect(created.draft.exclusions).toBeUndefined();
	});
});
