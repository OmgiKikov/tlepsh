import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listCorpora } from "../src/corpus.js";
import { loadTargetAdoptionReceipt } from "../src/application/target-adoption.js";
import { loadCycleContinuationReceipt } from "../src/workbench/cycle-continuation.js";
import {
	WorkbenchDecisionDeclinedError,
	createAhdeWorkbench,
	type AhdeWorkbench,
	type AhdeWorkbenchDependencies,
} from "../src/workbench/index.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";
import {
	ACTOR_ID,
	NOW,
	PROJECT_ID,
	cleanupPaths,
	gate,
	git,
	terminalCandidateFixture,
	writeDevelopmentEval,
	type CycleFixture,
	type FixturePaths,
	type RecordingGate,
} from "./helpers/cycle-fixtures.js";

const REASON = "Start testing this agent";
const SHIP_REASON = "Ship the reviewed candidate";
const EVAL_RUN_ID = "erun_composite_fixture";

const SPEC = {
	schemaVersion: 1 as const,
	title: "Support policy assistant",
	purpose: "Answer support policy questions from approved local evidence.",
	users: ["Support operators"],
	jobs: ["Answer one policy question"],
	inputs: ["A policy question"],
	allowedActions: ["Read approved local policy"],
	successCriteria: ["Answer contains the applicable policy"],
	constraints: ["Never invent policy"],
	openQuestions: [],
};

const TASKS = [
	{ input: "What is the refund window?", graders: [{ type: "output_contains" as const, text: "30 days" }] },
	{ input: "When does the warranty start?", graders: [{ type: "output_contains" as const, text: "delivery" }] },
];

function paths(): FixturePaths {
	const projectDir = makeTargetFixture(baseFixtureFiles({ ".gitignore": ".ahde/\nruns/\n" }));
	return { projectDir, stateRoot: join(projectDir, ".ahde"), runsRoot: join(projectDir, "runs") };
}

/** Every durable file under one root, as `relative path → exact contents`. */
function tree(root: string, replace: readonly (readonly [string, string])[] = []): Record<string, string> {
	const files: Record<string, string> = {};
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory).sort()) {
			const full = join(directory, entry);
			if (statSync(full).isDirectory()) {
				walk(full);
				continue;
			}
			let content = readFileSync(full, "utf8");
			for (const [from, to] of replace) content = content.split(from).join(to);
			files[relative(root, full)] = content;
		}
	};
	walk(root);
	return files;
}

const FOCUS_FILE = join("projects", PROJECT_ID, "workbench", "focus.json");

/** Every durable receipt: the state tree without the mutable focus selection. */
function receipts(fixture: FixturePaths): Record<string, string> {
	const files = tree(fixture.stateRoot, [[fixture.projectDir, "<project>"]]);
	delete files[FOCUS_FILE];
	return files;
}

/** What focus points at, without the hashes that bind it to one repository. */
function focusIds(fixture: FixturePaths): Record<string, string> {
	const focus = JSON.parse(readFileSync(join(fixture.stateRoot, FOCUS_FILE), "utf8")) as {
		selections: Record<string, { id: string }>;
	};
	return Object.fromEntries(
		Object.entries(focus.selections).map(([kind, selection]) => [kind, selection.id]),
	);
}

function workbenchFor(
	fixture: FixturePaths,
	dependencies: Partial<AhdeWorkbenchDependencies> = {},
): AhdeWorkbench {
	return createAhdeWorkbench({
		...fixture,
		projectId: PROJECT_ID,
		dependencies: {
			now: () => NOW,
			// A real EvalRun on disk, so the diagnosis and brief downstream of the
			// run are the production ones rather than another stub.
			runSuite: (async () => {
				const corpus = listCorpora({ stateRoot: fixture.stateRoot, projectId: PROJECT_ID })
					.find((candidate) => candidate.visibility === "development");
				if (!corpus) throw new Error("no development corpus was published before the run");
				return writeDevelopmentEval(fixture, corpus.id, EVAL_RUN_ID);
			}) as AhdeWorkbenchDependencies["runSuite"],
			...dependencies,
		},
	});
}

/** Spec draft + Spec-bound corpus draft: the state “start testing” acts on. */
async function drafted(
	fixture: FixturePaths,
	dependencies: Partial<AhdeWorkbenchDependencies> = {},
): Promise<AhdeWorkbench> {
	const workbench = workbenchFor(fixture, dependencies);
	await workbench.submit({ kind: "spec-draft", spec: SPEC });
	return workbench;
}

async function addCorpusDraft(workbench: AhdeWorkbench): Promise<void> {
	await workbench.submit({
		kind: "corpus-draft",
		name: "Reviewed development basket",
		tasks: TASKS,
		coverageNotes: ["Two independent policy questions."],
		revisionSummary: "Initial development basket",
	});
}

describe("start-testing composite", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/**
	 * Two independent projects, one frozen clock. Corpus metadata stamps its own
	 * `createdAt`, so without this the two publications would differ by
	 * milliseconds and every receipt digest under them with it.
	 */
	function freezeClock(): void {
		vi.useFakeTimers({ toFake: ["Date"], now: new Date(NOW) });
	}

	it("writes exactly the receipts approve-spec + publish-corpus + run-eval write, in the same order", async () => {
		const composite = paths();
		const separate = paths();
		freezeClock();
		try {
			// One dialog.
			const first = await drafted(composite);
			const compositeGate = gate();
			const approved = await first.decide({ kind: "start-testing", repetitions: 1, reason: REASON }, compositeGate);
			expect(approved.result.steps.map((step) => step.kind)).toEqual(["approve-spec"]);
			await addCorpusDraft(first);
			const ran = await first.decide({ kind: "start-testing", repetitions: 1, reason: REASON }, compositeGate);
			expect(ran.result.steps.map((step) => step.kind)).toEqual(["publish-corpus", "run-eval"]);
			expect(ran.result.evaluation?.evaluation.evalRunId).toBe(EVAL_RUN_ID);
			expect(compositeGate.confirm).toHaveBeenCalledTimes(2);

			// The same work as three separate host-confirmed decisions.
			const second = await drafted(separate);
			const stepGate = gate();
			await second.decide({ kind: "approve-spec", reason: REASON }, stepGate);
			await addCorpusDraft(second);
			await second.decide({ kind: "publish-corpus", reason: REASON }, stepGate);
			await second.decide({ kind: "run-eval", repetitions: 1, reason: REASON }, stepGate);
			expect(stepGate.confirm).toHaveBeenCalledTimes(3);

			// Byte-identical durable state: the same approval receipt, the same
			// corpus, the same publication receipt and the same Workbench lineage.
			// Focus is compared separately: it is selection, never authority, and
			// it records the hash of an EvalRun that carries each fixture's own
			// Git revision.
			expect(receipts(composite)).toEqual(receipts(separate));
			expect(focusIds(composite)).toEqual(focusIds(separate));
			expect((await first.view()).stage).toBe((await second.view()).stage);
		} finally {
			cleanup(composite.projectDir);
			cleanup(separate.projectDir);
		}
	});

	it("shows the Spec, the case count and the run estimate in its one dialog", async () => {
		const fixture = paths();
		try {
			const workbench = await drafted(fixture);
			const human = gate();
			await workbench.decide({ kind: "start-testing", repetitions: 1, reason: REASON }, human);
			await addCorpusDraft(workbench);
			await workbench.decide({ kind: "start-testing", repetitions: 3, reason: REASON }, human);

			const confirmation = human.confirm.mock.calls[1]?.[0];
			expect(confirmation).toMatchObject({
				kind: "start-testing",
				policy: "consequential",
				title: "Start testing — publish the eval basket, run 6 Target executions",
				subject: {
					operation: "start-testing",
					steps: ["publish-corpus", "run-eval"],
					spec: "Support policy assistant — already approved",
					basket: "Reviewed development basket · 2 cases",
					run: "2 × 3 = 6 Target executions",
					estimatedCost: "unknown · nothing comparable has run yet",
					estimatedTime: "unknown · nothing comparable has run yet",
				},
			});
			expect(confirmation?.subjectHash).toMatch(/^sha256:[0-9a-f]{64}$/);
			// The sub-decisions never reach the human: one intent, one question.
			expect(human.confirm).toHaveBeenCalledTimes(2);
		} finally {
			cleanup(fixture.projectDir);
		}
	});

	it("stops at the first step that fails and leaves what the separate decisions leave", async () => {
		const composite = paths();
		const separate = paths();
		const failure = (): never => {
			throw new Error("publication is unavailable in this fixture");
		};
		freezeClock();
		try {
			const first = await drafted(composite, { publishDevelopmentCorpus: failure });
			const compositeGate = gate();
			await first.decide({ kind: "start-testing", repetitions: 1, reason: REASON }, compositeGate);
			await addCorpusDraft(first);
			await expect(first.decide({ kind: "start-testing", repetitions: 1, reason: REASON }, compositeGate))
				.rejects.toThrow(/publication is unavailable/);

			const second = await drafted(separate, { publishDevelopmentCorpus: failure });
			const stepGate = gate();
			await second.decide({ kind: "approve-spec", reason: REASON }, stepGate);
			await addCorpusDraft(second);
			await expect(second.decide({ kind: "publish-corpus", reason: REASON }, stepGate))
				.rejects.toThrow(/publication is unavailable/);

			expect(receipts(composite)).toEqual(receipts(separate));
			// The approval stands, the publication does not, and nothing ran.
			expect((await first.view()).stage).toBe("corpus-review");
			expect(listCorpora({ stateRoot: composite.stateRoot, projectId: PROJECT_ID })).toEqual([]);
			expect(existsSync(composite.runsRoot)).toBe(false);
		} finally {
			cleanup(composite.projectDir);
			cleanup(separate.projectDir);
		}
	});

	it("writes nothing at all when the one dialog is declined", async () => {
		const fixture = paths();
		try {
			const workbench = await drafted(fixture);
			const before = tree(fixture.stateRoot);
			const declined = gate(false);
			await expect(workbench.decide({ kind: "start-testing", repetitions: 1, reason: REASON }, declined))
				.rejects.toBeInstanceOf(WorkbenchDecisionDeclinedError);
			expect(declined.confirm).toHaveBeenCalledOnce();
			expect(tree(fixture.stateRoot)).toEqual(before);
			expect((await workbench.view()).stage).toBe("spec-review");
		} finally {
			cleanup(fixture.projectDir);
		}
	});
});

/** The values two independently created repositories cannot share. */
function shipReplacements(fixture: CycleFixture): (readonly [string, string])[] {
	return [
		[fixture.projectDir, "<project>"],
		[fixture.baselineSha, "<baseline>"],
		[fixture.candidateSha, "<candidate>"],
	];
}

/**
 * Receipt ids are digests over subjects that carry those revisions, and the
 * Builder run id is a UUID. Everything else — actors, reasons, timestamps,
 * branches, tags, verdicts, dispositions, file names — still compares exactly.
 */
function withoutDigests(files: Record<string, string>): Record<string, string> {
	const mask = (content: string): string => content
		.replace(/[0-9a-f]{64}/g, "<digest>")
		.replace(/[0-9a-f]{40}/g, "<sha>")
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
		// Corpus metadata stamps its own wall clock; every decision timestamp in
		// these fixtures is the injected NOW and still compares exactly.
		.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, (stamp) => (stamp === NOW ? stamp : "<clock>"));
	return Object.fromEntries(Object.entries(files).map(([path, content]) => [mask(path), mask(content)]));
}

describe("ship composite", () => {
	it("writes the same adoption and continuation receipts as the separate decisions", async () => {
		let composite: CycleFixture | undefined;
		let separate: CycleFixture | undefined;
		try {
			composite = await terminalCandidateFixture("promoted");
			separate = await terminalCandidateFixture("promoted");

			const compositeGate = gate();
			const shipped = await composite.workbench.decide({ kind: "ship", reason: SHIP_REASON }, compositeGate);
			expect(compositeGate.confirm).toHaveBeenCalledOnce();
			expect(shipped.result.steps.map((step) => step.kind)).toEqual(["adopt-candidate", "continue-cycle"]);

			const stepGate = gate();
			await separate.workbench.decide({ kind: "adopt-candidate", reason: SHIP_REASON }, stepGate);
			await separate.workbench.decide({ kind: "continue-cycle", reason: SHIP_REASON }, stepGate);
			expect(stepGate.confirm).toHaveBeenCalledTimes(2);

			expect(withoutDigests(tree(composite.stateRoot, shipReplacements(composite))))
				.toEqual(withoutDigests(tree(separate.stateRoot, shipReplacements(separate))));

			// The receipts themselves, read back through their loaders.
			const adopted = loadTargetAdoptionReceipt(composite.stateRoot, composite.candidateId);
			expect(adopted).toMatchObject({
				previousHead: composite.baselineSha,
				adoptedHead: composite.candidateSha,
				branchRef: `refs/heads/${composite.branch}`,
				adoptedAt: NOW,
				intent: { actor: { kind: "human", id: ACTOR_ID }, reason: SHIP_REASON },
			});
			expect(loadCycleContinuationReceipt(composite.stateRoot, composite.projectId, composite.candidateId))
				.toMatchObject({ continuedAt: NOW, actor: { kind: "human", id: ACTOR_ID }, reason: SHIP_REASON });
			expect(shipped.result.adoption).toEqual({
				branch: composite.branch,
				fromSha: composite.baselineSha,
				toSha: composite.candidateSha,
			});
			expect(shipped.result.continuation?.nextStage).toBe("ready-to-evaluate");
			expect(git(composite.projectDir, "rev-parse", "HEAD")).toBe(composite.candidateSha);
			expect(shipped.view.stage).toBe("ready-to-evaluate");
		} finally {
			cleanupPaths(composite);
			cleanupPaths(separate);
		}
	});

	it("shows both verdicts, the tag and the fast-forward before anything moves", async () => {
		let fixture: CycleFixture | undefined;
		try {
			fixture = await terminalCandidateFixture("promoted");
			const human = gate();
			await fixture.workbench.decide({ kind: "ship", reason: SHIP_REASON }, human);
			expect(human.confirm.mock.calls[0]?.[0]).toMatchObject({
				kind: "ship",
				policy: "consequential",
				title: "Ship this candidate",
				subject: {
					operation: "ship",
					steps: ["adopt-candidate", "continue-cycle"],
					candidateId: fixture.candidateId,
					// The exact sentence the panel showed, not a digest of it.
					development: "improved · score 0% → 100% (+100 pts, 95% CI +100 … +100) on 15 cases × 2 · pass rate 0% → 100%",
					sealed: "pass · 15 × 2",
					fastForward: `${fixture.branch} ${fixture.baselineSha.slice(0, 10)} → ${fixture.candidateSha.slice(0, 10)}`,
					candidate: { candidateId: fixture.candidateId, status: "promoted" },
				},
			});
		} finally {
			cleanupPaths(fixture);
		}
	});

	it("stops at the first step that fails, and writes nothing when declined", async () => {
		let failing: CycleFixture | undefined;
		let declining: CycleFixture | undefined;
		try {
			declining = await terminalCandidateFixture("promoted");
			const before = tree(declining.stateRoot);
			const declined = gate(false);
			await expect(declining.workbench.decide({ kind: "ship", reason: SHIP_REASON }, declined))
				.rejects.toBeInstanceOf(WorkbenchDecisionDeclinedError);
			expect(declined.confirm).toHaveBeenCalledOnce();
			expect(tree(declining.stateRoot)).toEqual(before);
			expect(git(declining.projectDir, "rev-parse", "HEAD")).toBe(declining.baselineSha);
			expect((await declining.workbench.view()).stage).toBe("candidate-adoption");

			// A failing adoption leaves the cycle open: no continuation receipt.
			const recordCycleContinuation = vi.fn();
			failing = await terminalCandidateFixture("promoted", {
				adoptTargetCandidate: () => {
					throw new Error("worktree moved under the adoption");
				},
				recordCycleContinuation: recordCycleContinuation as never,
			});
			await expect(failing.workbench.decide({ kind: "ship", reason: SHIP_REASON }, gate()))
				.rejects.toThrow(/worktree moved under the adoption/);
			expect(recordCycleContinuation).not.toHaveBeenCalled();
			expect(git(failing.projectDir, "rev-parse", "HEAD")).toBe(failing.baselineSha);
			expect((await failing.workbench.view()).stage).toBe("candidate-adoption");
		} finally {
			cleanupPaths(failing);
			cleanupPaths(declining);
		}
	});

	it("refuses to ship a rejected candidate and names the cycle instead", async () => {
		let fixture: CycleFixture | undefined;
		try {
			fixture = await terminalCandidateFixture("rejected");
			const human: RecordingGate = gate();
			await expect(fixture.workbench.decide({ kind: "ship", reason: SHIP_REASON }, human))
				.rejects.toThrow(/was rejected; there is nothing to ship/);
			expect(human.confirm).not.toHaveBeenCalled();
		} finally {
			cleanupPaths(fixture);
		}
	});
});
