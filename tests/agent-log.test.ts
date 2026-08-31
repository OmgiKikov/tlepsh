import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	compileAgentLog,
	formatResolvedModes,
	MAX_RESOLVED_MODE_EXAMPLES,
	MAX_SPARKLINE_WIDTH,
	sparkline,
	type AgentLog,
} from "../src/application/agent-log.js";
import { promoteReviewedCandidate } from "../src/application/candidate-review.js";
import { collectEvalReportData, renderEvalReportHtml } from "../src/report.js";
import { renderAgentLog } from "../src/builder/render/agent-log.js";
import { plainPaint } from "../src/builder/render/paint.js";
import { SEALED_VERIFICATION_REPETITIONS } from "./helpers/sealed-holdout.js";
import { hashFile } from "../src/provenance.js";
import {
	approvingGate,
	DEVELOPMENT_CASES,
	improveFixture,
	READY_INSTRUCTION,
	recordFixtureProposal,
} from "./helpers/improve-fixtures.js";

/**
 * The agent's growth, version by version.
 *
 * Every fact `ahde log` prints is already durable in an immutable Candidate
 * record. These tests are about the reading: bounded, ordered, honest about
 * rejections, and silent about everything sealed.
 */

const paths: string[] = [];

afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function runsRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "ahde-log-"));
	paths.push(root);
	mkdirSync(join(root, "candidates"), { recursive: true });
	return root;
}

const SHA_A = "1".repeat(40);
const SHA_B = "2".repeat(40);
const REV_A = { ref: "main", sha: SHA_A };
const REV_B = { ref: "candidate/fixture", sha: SHA_B };
const FINGERPRINT = `sha256:${"e".repeat(64)}`;
const artifact = (path: string) => ({ path, sha256: FINGERPRINT });

/** A promotion is legal only on a reconstructable applied-Builder chain. */
function appliedBuilderOrigin(root: string, id: string, at: string, projectId: string, applyReason: string) {
	const builderRunId = `${id}-proposal`;
	return {
		kind: "applied-builder" as const,
		builderRunId,
		builderRun: artifact(join(root, "builders", builderRunId, "run.json")),
		builderInput: artifact(join(root, "builders", builderRunId, "input.json")),
		proposal: artifact(join(root, "builders", builderRunId, "proposal.json")),
		applyReceipt: artifact(join(root, "builders", builderRunId, "apply_receipt.json")),
		application: {
			actor: { kind: "human" as const, id: "local:test" },
			reason: applyReason,
			appliedAt: at,
			baseTargetSha: SHA_A,
			candidateSha: SHA_B,
			proposalSha256: FINGERPRINT,
		},
		source: {
			evalRunId: "erun_source",
			evalRun: artifact(join(root, "erun_source", "eval_run.json")),
			diagnosisId: `${id}-diagnosis`,
			diagnosis: artifact(join(root, "erun_source", "diagnosis.json")),
			dataset: "development",
			datasetHash: FINGERPRINT,
			suiteHash: FINGERPRINT,
			developmentCorpus: null,
		},
		approvedSpec: {
			specId: `${id}-spec`,
			projectId,
			specContentHash: FINGERPRINT,
			snapshotHash: FINGERPRINT,
			artifact: artifact(join(root, "specs", `${id}-spec.json`)),
		},
	};
}

function gate(surface: "development" | "sealed", verdict: string, scoreDelta: number, tasks: number, costUsd = 0.1) {
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
			baseline: { runs: tasks * 3, costUsd, meanLatencyMs: 100, meanTokens: 10 },
			candidate: { runs: tasks * 3, costUsd: costUsd * 2, meanLatencyMs: 120, meanTokens: 12 },
			costRatio: 2,
			latencyRatio: 1.2,
			tokenRatio: 1.2,
		},
	};
}

interface CandidateFixture {
	at: string;
	targetId?: string;
	projectId?: string;
	outcome: "promoted" | "rejected" | "evaluated";
	tag?: string;
	scoreDelta?: number;
	sealedVerdict?: string;
	reason?: string;
	/** The apply reason the receipt recorded. The autoloop's has a fixed shape. */
	applyReason?: string;
	/** Written to the receipt path, so the lenient read has a file to find. */
	receipt?: Record<string, unknown>;
}

function writeCandidate(root: string, id: string, options: CandidateFixture): void {
	const at = options.at;
	const projectId = options.projectId ?? "project-1";
	const promoted = options.outcome === "promoted";
	const applyReason = options.applyReason ?? "apply the reviewed proposal";
	// A promotion is legal only over sealed-holdout evidence, so every promoted
	// fixture carries one unless the test names another verdict.
	const sealedVerdict = options.sealedVerdict ?? (promoted ? "pass" : undefined);
	const events: unknown[] = [
		{ type: "proposed", eventId: `${id}-1`, at, actor: { kind: "builder", id: "builder" } },
		{ type: "built", eventId: `${id}-2`, at, actor: { kind: "human", id: "local:test" }, candidate: REV_B },
		{
			type: "validated",
			eventId: `${id}-2b`,
			at,
			actor: { kind: "system", id: "validator" },
			lineage: { baseline: REV_A, candidate: REV_B, relation: "descendant" },
			scope: {
				policyId: "harness-scope-v1",
				baselineSha: SHA_A,
				candidateSha: SHA_B,
				passed: true,
				changedFiles: ["AGENTS.md"],
				violations: [],
			},
		},
		{
			type: "evaluated",
			eventId: `${id}-3`,
			at,
			actor: { kind: "system", id: "evaluator" },
			evaluation: {
				experimentId: `${id}-exp`,
				designHash: `sha256:${"d".repeat(64)}`,
				mode: "candidate",
				development: {
					baseline: { evalRunId: `${id}_base`, harness: REV_A },
					candidate: { evalRunId: `${id}_cand`, harness: REV_B },
					comparison: gate("development", "improved", options.scoreDelta ?? 0.5, 30),
				},
				...(sealedVerdict
					? {
						sealedHoldout: {
							baseline: { evalRunId: `${id}_sealed_base`, harness: REV_A },
							candidate: { evalRunId: `${id}_sealed_cand`, harness: REV_B },
							// The holdout names its exact corpus on disk; a log row must
							// still refuse to pass that identity on.
							corpus: { id: "sealed-corpus-1", hash: FINGERPRINT },
							comparison: gate("sealed", sealedVerdict, 0.4, 15),
						},
					}
					: {}),
				infrastructureErrors: 0,
			},
		},
	];
	if (promoted) {
		events.push({
			type: "reviewed",
			eventId: `${id}-4`,
			at,
			actor: { kind: "human", id: "local:test" },
			review: { experimentId: `${id}-exp`, recommendation: "promote", reason: options.reason ?? "ship it" },
		});
		events.push({
			type: "promoted",
			eventId: `${id}-5`,
			at,
			actor: { kind: "human", id: "local:test" },
			decision: {
				experimentId: `${id}-exp`,
				candidate: REV_B,
				tag: options.tag ?? "v0.2.0",
				reason: options.reason ?? "ship it",
			},
		});
	}
	if (options.outcome === "rejected") {
		events.push({
			type: "reviewed",
			eventId: `${id}-4`,
			at,
			actor: { kind: "human", id: "local:test" },
			review: { experimentId: `${id}-exp`, recommendation: "reject", reason: options.reason ?? "too slow" },
		});
		events.push({
			type: "rejected",
			eventId: `${id}-5`,
			at,
			actor: { kind: "human", id: "local:test" },
			decision: { experimentId: `${id}-exp`, reason: options.reason ?? "too slow" },
		});
	}
	const record = {
		schemaVersion: 1,
		candidateId: id,
		projectId,
		targetId: options.targetId ?? "agent-1",
		specId: promoted ? `${id}-spec` : null,
		proposalId: `${id}-proposal`,
		diagnosisId: promoted ? `${id}-diagnosis` : null,
		origin: promoted
			? appliedBuilderOrigin(root, id, at, projectId, applyReason)
			: { kind: "manual", reason: "fixture candidate" },
		mode: "candidate",
		baseline: REV_A,
		createdAt: at,
		events,
	};
	if (options.receipt) {
		const builderDir = join(root, "builders", `${id}-proposal`);
		mkdirSync(builderDir, { recursive: true });
		const receiptPath = join(builderDir, "apply_receipt.json");
		const receiptBytes = `${JSON.stringify(options.receipt, null, "\t")}\n`;
		writeFileSync(receiptPath, receiptBytes);
		if ("applyReceipt" in record.origin) {
			record.origin.applyReceipt = { path: receiptPath, sha256: hashFile(receiptBytes) };
		}
	}
	const dir = join(root, "candidates", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "candidate.json"), `${JSON.stringify(record, null, "\t")}\n`);
}

function tags(log: AgentLog): string[] {
	return log.rows.map((row) => row.tag ?? row.outcome);
}

it("tells the growth story newest first, with rejections between the versions", () => {
	const root = runsRoot();
	writeCandidate(root, "cand-v1", { at: "2026-08-01T10:00:00.000Z", outcome: "promoted", tag: "v0.1.0", scoreDelta: 0.2, sealedVerdict: "pass", reason: "first real win" });
	writeCandidate(root, "cand-bad", { at: "2026-08-10T10:00:00.000Z", outcome: "rejected", reason: "3× the cost for +2pp" });
	writeCandidate(root, "cand-v2", { at: "2026-08-20T10:00:00.000Z", outcome: "promoted", tag: "v0.2.0", scoreDelta: 0.5, sealedVerdict: "pass", reason: "tool selection is reliable now" });
	// Reviewed but undecided: not a version and not an attempt that ended.
	writeCandidate(root, "cand-open", { at: "2026-08-22T10:00:00.000Z", outcome: "evaluated" });

	const log = compileAgentLog({ runsRoot: root, targetId: "agent-1" });

	expect(tags(log)).toEqual(["v0.2.0", "rejected", "v0.1.0"]);
	expect(log.rows[0]).toMatchObject({
		outcome: "promoted",
		tag: "v0.2.0",
		baseline: SHA_A.slice(0, 12),
		candidate: SHA_B.slice(0, 12),
		reason: "tool selection is reliable now",
		costRatio: 2,
		appliedByImprovementLoop: false,
	});
	expect(log.rows[0]?.development).toMatchObject({
		verdict: "improved",
		baselineScore: 0.4,
		candidateScore: 0.9,
		scoreDelta: 0.5,
		tasks: 30,
		repetitions: 3,
	});
	expect(log.rows[0]?.development?.confidence95).toEqual({ low: 0.4, high: 0.6 });
	// Oldest first: the chart reads left to right.
	expect(log.versions.map((version) => version.tag)).toEqual(["v0.1.0", "v0.2.0"]);
	expect(log.versions.map((version) => version.score)).toEqual([0.6000000000000001, 0.9]);
	// Both arms of both surfaces, for every decided attempt in the projection.
	expect(log.cumulativeCostUsd).toBeCloseTo(0.3 + 0.3 + 0.3 + 0.3 + 0.3, 6);
	expect(log.omitted).toBe(0);
	expect(log.unreadable).toBe(0);
});

it("keeps a sealed row to a verdict and a size, and says nothing else about the exam", () => {
	const root = runsRoot();
	writeCandidate(root, "cand-1", { at: "2026-08-20T10:00:00.000Z", outcome: "promoted", sealedVerdict: "pass" });

	const log = compileAgentLog({ runsRoot: root });
	const sealed = log.rows[0]?.sealed;

	expect(sealed).toEqual({ verdict: "pass", tasks: 15, repetitions: 3 });
	const serialized = JSON.stringify(log);
	expect(serialized).not.toContain("sealed-corpus-1");
	expect(serialized).not.toContain("sealed_base");
	expect(serialized).not.toContain("sealed_cand");
	// Nor may the rendered table put the exam back on the screen.
	const rendered = renderAgentLog(log, plainPaint).join("\n");
	expect(rendered).toContain("sealed pass on 15×3");
	expect(rendered).not.toContain("sealed-corpus-1");
});

it("says when the improvement loop applied the change, reading the receipt leniently", () => {
	const root = runsRoot();
	// The field a later revision may add. Read first, when it is there.
	writeCandidate(root, "cand-field", {
		at: "2026-08-20T10:00:00.000Z",
		outcome: "promoted",
		tag: "v0.3.0",
		receipt: { appliedBy: "improvement-loop", reason: "whatever the receipt says" },
	});
	// No such field yet: the exact reason the autoloop records still says it.
	writeCandidate(root, "cand-loop", {
		at: "2026-08-19T10:00:00.000Z",
		outcome: "promoted",
		tag: "v0.2.0",
		applyReason: "Autoloop cycle 2: apply the proposal for failure-mode-0123456789abcdef01234567.",
	});
	// A human applied this one, and no receipt file exists at all.
	writeCandidate(root, "cand-human", { at: "2026-08-18T10:00:00.000Z", outcome: "promoted", tag: "v0.1.0" });

	const byTag = new Map(
		compileAgentLog({ runsRoot: root }).rows.map((row) => [row.tag, row.appliedByImprovementLoop]),
	);

	expect(byTag.get("v0.3.0")).toBe(true);
	expect(byTag.get("v0.2.0")).toBe(true);
	expect(byTag.get("v0.1.0")).toBe(false);
});

it("derives an apply receipt from the runs root instead of trusting its recorded path", () => {
	const root = runsRoot();
	writeCandidate(root, "cand-path", {
		at: "2026-08-20T10:00:00.000Z",
		outcome: "promoted",
		tag: "v0.4.0",
		receipt: { appliedBy: "human", reason: "reviewed by the operator" },
	});
	const candidatePath = join(root, "candidates", "cand-path", "candidate.json");
	const candidate = JSON.parse(readFileSync(candidatePath, "utf8")) as {
		origin: { applyReceipt: { path: string } };
	};
	const foreignRoot = runsRoot();
	const foreignReceipt = join(foreignRoot, "forged-receipt.json");
	writeFileSync(foreignReceipt, '{"appliedBy":"improvement-loop"}\n');
	candidate.origin.applyReceipt.path = foreignReceipt;
	writeFileSync(candidatePath, `${JSON.stringify(candidate, null, "\t")}\n`);

	expect(compileAgentLog({ runsRoot: root }).rows[0]?.appliedByImprovementLoop).toBe(false);
});

it("bounds the rows and counts what did not fit", () => {
	const root = runsRoot();
	for (let index = 0; index < 5; index += 1) {
		writeCandidate(root, `cand-${index}`, {
			at: `2026-08-0${index + 1}T10:00:00.000Z`,
			outcome: index % 2 === 0 ? "promoted" : "rejected",
			tag: `v0.${index}.0`,
		});
	}

	const bounded = compileAgentLog({ runsRoot: root, limit: 2 });

	expect(bounded.rows).toHaveLength(2);
	expect(tags(bounded)).toEqual(["v0.4.0", "rejected"]);
	expect(bounded.omitted).toBe(3);
	// The chart is the chart of what is shown, and says so by matching the rows.
	expect(bounded.versions.map((version) => version.tag)).toEqual(["v0.4.0"]);
	expect(renderAgentLog(bounded, plainPaint).join("\n")).toContain("and 3 earlier decided attempt");
	expect(() => compileAgentLog({ runsRoot: root, limit: Number.POSITIVE_INFINITY }))
		.toThrow(/agent log limit must be a finite number/);
});

it("separates Targets and projects, and counts an unreadable record instead of failing", () => {
	const root = runsRoot();
	writeCandidate(root, "cand-mine", { at: "2026-08-20T10:00:00.000Z", outcome: "promoted", tag: "v1.0.0" });
	writeCandidate(root, "cand-other-target", { at: "2026-08-21T10:00:00.000Z", outcome: "promoted", targetId: "agent-2", tag: "v9.9.9" });
	writeCandidate(root, "cand-other-project", { at: "2026-08-22T10:00:00.000Z", outcome: "promoted", projectId: "project-2", tag: "v8.8.8" });
	mkdirSync(join(root, "candidates", "cand-broken"), { recursive: true });
	writeFileSync(join(root, "candidates", "cand-broken", "candidate.json"), "{ not json");

	const log = compileAgentLog({ runsRoot: root, targetId: "agent-1", projectId: "project-1" });

	expect(tags(log)).toEqual(["v1.0.0"]);
	expect(log.unreadable).toBe(1);
});

it("keeps the sparkline inside its column budget", () => {
	const values = Array.from({ length: MAX_SPARKLINE_WIDTH * 3 }, (_, index) => index / (MAX_SPARKLINE_WIDTH * 3));

	const line = sparkline(values);

	expect([...line]).toHaveLength(MAX_SPARKLINE_WIDTH);
	// The newest points win: a chart of a long history still shows today.
	expect(line.endsWith("█")).toBe(true);
	expect([...sparkline([0, 0.5, 1])]).toEqual(["▁", "▅", "█"]);
	expect(sparkline([0.5], 0)).toBe("");
	expect([...sparkline(values, 1_000)]).toHaveLength(MAX_SPARKLINE_WIDTH);
});

it("renders a projection that survives --json unchanged", () => {
	const root = runsRoot();
	writeCandidate(root, "cand-1", { at: "2026-08-20T10:00:00.000Z", outcome: "promoted", tag: "v0.2.0", sealedVerdict: "pass" });

	const log = compileAgentLog({ runsRoot: root, targetId: "agent-1", projectId: "project-1" });
	const roundTripped = JSON.parse(JSON.stringify(log)) as AgentLog;

	expect(roundTripped).toEqual(log);
	expect(Object.keys(roundTripped).sort()).toEqual([
		"cumulativeCostUsd", "omitted", "projectId", "rows", "targetId", "unreadable", "versions",
	]);
	expect(Object.keys(roundTripped.rows[0] ?? {}).sort()).toEqual([
		"appliedByImprovementLoop", "at", "baseline", "candidate", "candidateId", "costRatio", "costUsd",
		"development", "outcome", "reason", "resolvedModes", "sealed", "tag",
	]);
});

it("says nothing rather than inventing a curve on an empty project", () => {
	const log = compileAgentLog({ runsRoot: runsRoot(), targetId: "agent-1" });

	expect(log.rows).toEqual([]);
	expect(log.versions).toEqual([]);
	expect(log.cumulativeCostUsd).toBe(0);
	expect(renderAgentLog(log, plainPaint).join("\n")).toContain("Nothing has been promoted or rejected");
});

it(
	"names the failure modes a promotion actually resolved, from the flips and the source diagnosis",
	async () => {
		const fixture = await improveFixture();
		try {
			const proposal = await recordFixtureProposal(fixture, READY_INSTRUCTION);
			await fixture.workbench.decide({
				kind: "apply-proposal",
				runId: proposal.runId,
				branch: "candidate/log",
				reason: "Apply the reviewed fixture proposal",
			}, approvingGate());
			const verified = await fixture.workbench.decide({
				kind: "verify-candidate",
				repetitions: SEALED_VERIFICATION_REPETITIONS,
				reason: "Verify the applied candidate",
			}, approvingGate());
			if (verified.result.outcome !== "verified") throw new Error("the fixture candidate was stopped by its screen");
			const reviewed = await fixture.workbench.decide({
				kind: "review-candidate",
				recommendation: "promote",
				reason: "The development gain is real and the sealed guardrail passed.",
			}, approvingGate());
			promoteReviewedCandidate({
				repositoryDir: fixture.projectDir,
				runsRoot: fixture.runsRoot,
				stateRoot: fixture.stateRoot,
				candidateId: reviewed.result.candidateId,
				version: "0.2.0",
				reason: "The answer contract is explicit now.",
			});

			const log = compileAgentLog({ runsRoot: fixture.runsRoot, projectId: fixture.projectId });
			const row = log.rows[0];

			expect(row).toMatchObject({ outcome: "promoted", tag: "v0.2.0" });
			// Both development cases flipped fail→pass, and the mode the proposal
			// was authored against is the mode that got resolved.
			expect(row?.resolvedModes.flippedTasks).toBe(DEVELOPMENT_CASES.length);
			expect(row?.resolvedModes.count).toBeGreaterThanOrEqual(1);
			expect(row?.resolvedModes.examples.length).toBeGreaterThanOrEqual(1);
			expect(row?.resolvedModes.examples.length).toBeLessThanOrEqual(MAX_RESOLVED_MODE_EXAMPLES);
			// A human applied this one through the Workbench gate.
			expect(row?.appliedByImprovementLoop).toBe(false);
			// The chart has its first point, and it is the score the gate measured.
			expect(log.versions).toHaveLength(1);
			expect(log.versions[0]?.score).toBe(row?.development?.candidateScore);
			expect(renderAgentLog(log, plainPaint).join("\n")).toContain("resolved");

			// The same projection reaches the HTML report as an optional section,
			// and only when a project is known.
			const withProject = collectEvalReportData(fixture.runsRoot, fixture.evalRunId, undefined, {
				allowDiagnosisCreation: false,
				labels: { stateRoot: fixture.stateRoot, projectId: fixture.projectId },
			});
			expect(withProject.agentLog?.rows).toHaveLength(1);
			expect(withProject.agentLog?.rows[0]?.tag).toBe("v0.2.0");
			const withoutProject = collectEvalReportData(fixture.runsRoot, fixture.evalRunId, undefined, {
				allowDiagnosisCreation: false,
			});
			expect(withoutProject.agentLog).toBeNull();

			const html = renderEvalReportHtml(withProject);
			expect(html).toContain('id="growth-section"');
			expect(html).toContain("<h2>Growth</h2>");
			expect(html).toContain("v0.2.0");
			// The sections that were already there are untouched.
			expect(html).toContain('id="comparison-section"');
			expect(html).toContain("<h2>Failure modes</h2>");
			expect(html).toContain("<h2>Trace inspector</h2>");
			// And the growth section still says nothing about the sealed exam.
			expect(html).not.toContain(fixture.sealedCorpusId);
			// Without a project the section is inert rather than half-filled.
			const withoutHtml = renderEvalReportHtml(withoutProject);
			expect(withoutHtml).toContain('id="growth-section" hidden');
			expect(withoutHtml).toContain('"agentLog":null');
		} finally {
			await fixture.close();
		}
	},
	240_000,
);

it("names resolved failure modes bounded, and never a task id", () => {
	expect(formatResolvedModes({ count: 0, examples: [], omitted: 0, flippedTasks: 0 })).toBe("—");
	expect(formatResolvedModes({ count: 1, examples: ["Required tool check failed"], omitted: 0, flippedTasks: 2 }))
		.toBe("1 mode, e.g. Required tool check failed");
	expect(formatResolvedModes({ count: 5, examples: ["a", "b", "c"], omitted: 2, flippedTasks: 9 }))
		.toBe("5 modes, e.g. a; b; c");
});
