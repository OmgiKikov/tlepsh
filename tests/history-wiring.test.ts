import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectTargetAuthoringContext } from "../src/application/target-authoring-context.js";
import {
	compactExperimentHistory,
	compileExperimentHistory,
} from "../src/application/experiment-history.js";
import { createAhdeWorkbench } from "../src/workbench/index.js";
import { renderHistory, renderTarget, viewTitle } from "../src/builder/render/view.js";
import { plainPaint } from "../src/builder/render/paint.js";
import { projectForModel } from "../src/builder/workbench-adapter.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

/**
 * The memory, wired. `compileExperimentHistory` was proven in isolation and
 * called by nothing; these tests are about the two places the Builder actually
 * reads it — one bounded view aspect, and the authoring context it reads
 * immediately before it proposes.
 */

const roots: string[] = [];
const PROJECT_ID = "test-target";
const TARGET_ID = "test-target";
const SHA_A = "1".repeat(40);
const SHA_B = "2".repeat(40);
const FINGERPRINT = `sha256:${"e".repeat(64)}`;

afterEach(() => {
	for (const root of roots.splice(0)) cleanup(root);
});

function fixture(): { projectDir: string; stateRoot: string; runsRoot: string } {
	const projectDir = makeTargetFixture(baseFixtureFiles({ ".gitignore": ".ahde/\nruns/\n" }));
	roots.push(projectDir);
	return { projectDir, stateRoot: join(projectDir, ".ahde"), runsRoot: join(projectDir, "runs") };
}

function gate(surface: "development" | "sealed", verdict: string, scoreDelta: number, tasks: number) {
	return {
		schemaVersion: 4,
		algorithmId: "exact-comparison-gate-v4",
		policyId: surface === "sealed" ? "sealed-guardrail-v4" : "development-ci-v4",
		surface,
		comparisonHash: `sha256:${"a".repeat(64)}`,
		evidenceHash: `sha256:${"b".repeat(64)}`,
		gateHash: `sha256:${"c".repeat(64)}`,
		summary: {
			taskCount: tasks,
			baselinePassRate: 0.4,
			candidatePassRate: 0.9,
			delta: 0.5,
			baselineScore: 0.4,
			candidateScore: 0.4 + scoreDelta,
			scoreDelta,
			confidence95: { low: scoreDelta - 0.1, high: scoreDelta + 0.1 },
			improved: tasks,
			regressed: 0,
			unchanged: 0,
		},
		design: { tasks, repetitions: 3, excludedTasks: 0 },
		verdict,
		flags: { regressedTasks: 0, improvedTasks: tasks, collapsedTasks: 0 },
		reasons: [`${verdict} on ${tasks} tasks × 3 repetitions`],
		resources: {
			baseline: { runs: tasks * 3, costUsd: 0.1, meanLatencyMs: 100, meanTokens: 10 },
			candidate: { runs: tasks * 3, costUsd: 0.1, meanLatencyMs: 100, meanTokens: 10 },
			costRatio: 1,
			latencyRatio: 1,
			tokenRatio: 1,
		},
	};
}

/**
 * One immutable candidate record, exactly the shape the read side already
 * proves it can compile: an evaluated experiment a human then rejected.
 */
function writeRejectedCandidate(runsRoot: string, id: string, at: string, changedFiles: string[], reason: string): void {
	const actor = { kind: "human" as const, id: "local:test" };
	const record = {
		schemaVersion: 1,
		candidateId: id,
		projectId: PROJECT_ID,
		targetId: TARGET_ID,
		specId: null,
		proposalId: `${id}-proposal`,
		diagnosisId: null,
		origin: { kind: "manual", reason: "history wiring fixture" },
		mode: "candidate",
		baseline: { ref: "main", sha: SHA_A },
		createdAt: at,
		events: [
			{ type: "proposed", eventId: `${id}-1`, at, actor: { kind: "builder", id: "builder" } },
			{ type: "built", eventId: `${id}-2`, at, actor, candidate: { ref: "candidate/x", sha: SHA_B } },
			{
				type: "validated",
				eventId: `${id}-3`,
				at,
				actor: { kind: "system", id: "validator" },
				lineage: {
					baseline: { ref: "main", sha: SHA_A },
					candidate: { ref: "candidate/x", sha: SHA_B },
					relation: "descendant",
				},
				scope: {
					policyId: "harness-scope-v1",
					baselineSha: SHA_A,
					candidateSha: SHA_B,
					passed: true,
					changedFiles,
					violations: [],
				},
			},
			{
				type: "evaluated",
				eventId: `${id}-4`,
				at,
				actor: { kind: "system", id: "evaluator" },
				evaluation: {
					experimentId: `${id}-exp`,
					designHash: `sha256:${"d".repeat(64)}`,
					mode: "candidate",
					development: {
						baseline: { evalRunId: "erun_base", harness: { ref: "main", sha: SHA_A } },
						candidate: { evalRunId: "erun_cand", harness: { ref: "candidate/x", sha: SHA_B } },
						comparison: gate("development", "inconclusive", 0.01, 30),
					},
					sealedHoldout: {
						baseline: { evalRunId: "erun_sealed_base", harness: { ref: "main", sha: SHA_A } },
						candidate: { evalRunId: "erun_sealed_cand", harness: { ref: "candidate/x", sha: SHA_B } },
						corpus: { id: "sealed-corpus-secret", hash: FINGERPRINT },
						comparison: gate("sealed", "underpowered", 0.02, 15),
					},
					infrastructureErrors: 0,
				},
			},
			{
				type: "reviewed",
				eventId: `${id}-5`,
				at,
				actor,
				review: { experimentId: `${id}-exp`, recommendation: "reject", reason },
			},
			{ type: "rejected", eventId: `${id}-6`, at, actor, decision: { experimentId: `${id}-exp`, reason } },
		],
	};
	const dir = join(runsRoot, "candidates", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "candidate.json"), `${JSON.stringify(record, null, "\t")}\n`);
}

it("answers `what did we already try` as a bounded view aspect that leaks nothing", async () => {
	const { projectDir, stateRoot, runsRoot } = fixture();
	writeRejectedCandidate(runsRoot, "cand-a", "2026-08-10T10:00:00.000Z", ["AGENTS.md"], "3× the cost for +1pp");
	writeRejectedCandidate(runsRoot, "cand-b", "2026-08-14T10:00:00.000Z", ["skills/check-dbo/SKILL.md"], "broke the refund flow");
	const workbench = createAhdeWorkbench({ projectDir, stateRoot, runsRoot, projectId: PROJECT_ID });

	const view = await workbench.view({ aspect: "history" });

	expect(view.detail?.aspect).toBe("history");
	const content = view.detail?.aspect === "history" ? view.detail.content : null;
	expect(content?.attempts.map((attempt) => attempt.candidateId)).toEqual(["cand-b", "cand-a"]);
	expect(content?.attempts[0]).toMatchObject({
		outcome: "rejected",
		changedPaths: ["skills/check-dbo/SKILL.md"],
		reason: "broke the refund flow",
	});
	expect(content?.attempts[0]?.development).toMatchObject({ verdict: "inconclusive" });
	expect(content?.omitted).toBe(0);
	expect(content?.unreadable).toBe(0);

	// The projection is Builder-visible: a sealed arm contributes a verdict and
	// a size, never a run id, a corpus identity, or a hash.
	const serialized = JSON.stringify(projectForModel(view));
	expect(serialized).toContain("underpowered");
	expect(serialized).not.toContain("sealed-corpus-secret");
	expect(serialized).not.toContain("erun_sealed_base");
	expect(serialized).not.toContain("erun_sealed_cand");
	expect(serialized).not.toContain("sha256:");
	expect(serialized).not.toContain(SHA_B);

	// And the host renders it for the operator, with the rule in one line.
	expect(viewTitle(view)).toBe("AHDE · Already tried");
	const lines = renderHistory(content!, plainPaint);
	expect(lines[0]).toContain("2 attempts");
	expect(lines.join("\n")).toContain("broke the refund flow");
	expect(lines.at(-1)).toContain("Never re-run an experiment that already lost");
});

it("says there is nothing yet instead of pretending the memory is empty", async () => {
	const { projectDir, stateRoot, runsRoot } = fixture();
	const workbench = createAhdeWorkbench({ projectDir, stateRoot, runsRoot, projectId: PROJECT_ID });

	const view = await workbench.view({ aspect: "history" });
	const content = view.detail?.aspect === "history" ? view.detail.content : null;

	expect(content).toEqual({ attempts: [], omitted: 0, unreadable: 0 });
	expect(renderHistory(content!, plainPaint)[0]).toContain("this is the first change on this agent");
});

it("folds prior attempts into the authoring context and says how many it left out", async () => {
	const { projectDir, stateRoot, runsRoot } = fixture();
	for (let index = 1; index <= 10; index += 1) {
		const day = String(index).padStart(2, "0");
		writeRejectedCandidate(runsRoot, `cand-${day}`, `2026-08-${day}T10:00:00.000Z`, ["AGENTS.md"], `attempt ${day} regressed`);
	}
	const workbench = createAhdeWorkbench({ projectDir, stateRoot, runsRoot, projectId: PROJECT_ID });

	const view = await workbench.view({ aspect: "target" });
	const content = view.detail?.aspect === "target" ? view.detail.content : null;
	if (!content || !("target" in content)) throw new Error("expected an authoring context");

	// The Builder reads this right before it authors, so it must carry what was
	// already tried — capped, newest first, and honest about the remainder.
	expect(content.priorAttempts).toHaveLength(8);
	expect(content.priorAttemptsOmitted).toBe(2);
	expect(content.priorAttempts?.[0]).toMatchObject({
		outcome: "rejected",
		changedPaths: ["AGENTS.md"],
		reason: "attempt 10 regressed",
		development: "inconclusive +1.0pp",
		sealed: "underpowered",
	});
	expect(renderTarget(content, plainPaint).join("\n")).toContain("and 2 earlier attempts not shown");

	// The claim is exact Git and only exact Git: attaching a memory that changes
	// every time a candidate finishes must not expire a stored claim.
	const withoutHistory = inspectTargetAuthoringContext({
		repositoryDir: projectDir,
		expectedTarget: { id: content.target.id, gitSha: content.target.gitSha },
	});
	expect(withoutHistory.contextHash).toBe(content.contextHash);
	expect(withoutHistory.claim).toEqual(content.claim);
	expect(withoutHistory.priorAttempts).toBeUndefined();
	// Nothing sealed and no digest reaches the model through this path either.
	const serialized = JSON.stringify(projectForModel(content.priorAttempts));
	expect(serialized).not.toContain("sealed-corpus-secret");
	expect(serialized).not.toContain("sha256:");
});

it("keeps the memory inside the authoring context's own byte budget", () => {
	const { projectDir, runsRoot } = fixture();
	for (let index = 1; index <= 9; index += 1) {
		writeRejectedCandidate(
			runsRoot,
			`cand-${index}`,
			`2026-08-0${index}T10:00:00.000Z`,
			["AGENTS.md", "skills/check-dbo/SKILL.md"],
			"x".repeat(280),
		);
	}
	const history = compactExperimentHistory(compileExperimentHistory({ runsRoot }), { limit: 9 });
	expect(history.attempts).toHaveLength(9);

	const bounded = inspectTargetAuthoringContext({
		repositoryDir: projectDir,
		expectedTarget: { id: TARGET_ID, gitSha: gitSha(projectDir) },
		history,
	});

	// Whatever survives, the count is exact: kept + omitted is what exists.
	expect((bounded.priorAttempts?.length ?? 0) + (bounded.priorAttemptsOmitted ?? 0)).toBe(9);
	expect(Buffer.byteLength(JSON.stringify(bounded.priorAttempts ?? []), "utf8")).toBeLessThanOrEqual(8 * 1024);
});

function gitSha(projectDir: string): string {
	return execFileSync("git", ["-C", projectDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}
