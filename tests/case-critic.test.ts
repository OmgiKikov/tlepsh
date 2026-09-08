import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	criticCounts,
	critiqueCases,
	parseCriticReply,
	specTextOf,
	loadCriticReceipt,
	saveCriticReceipt,
	type CriticCase,
} from "../src/application/case-critic.js";
import { ModelBlock } from "../src/manifest.js";
import { startMockModel, type MockModelHandle } from "../src/mock-model.js";
import type { AgentSpec } from "../src/spec.js";

const roots: string[] = [];
const mocks: MockModelHandle[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	for (const mock of mocks.splice(0)) await mock.close();
});

function root(): string {
	const path = mkdtempSync(join(tmpdir(), "ahde-case-critic-"));
	roots.push(path);
	return path;
}

function judgeModel(baseUrl: string) {
	return ModelBlock.parse({
		provider: "fixture-provider",
		id: "fixture-judge",
		api: "openai-completions",
		baseUrl,
		apiKeyEnv: "TEST_JUDGE_KEY",
		thinkingLevel: "off",
		timeoutMs: 30_000,
	});
}

function criticCase(id: string, input: string): CriticCase {
	return {
		task: { id, input, graders: [{ type: "output_matches" as const, pattern: "14" }] },
		sourceLabel: "data/kb/refunds.md",
		sourceText: "Refunds are issued within 14 days.",
	};
}

async function mockJudge(reply: string | { httpError: { status: number; message: string } }): Promise<MockModelHandle> {
	const mock = await startMockModel([{
		match: () => true,
		steps: [typeof reply === "string" ? { text: reply } : reply],
	}]);
	mocks.push(mock);
	return mock;
}

const spec: AgentSpec = {
	schemaVersion: 1,
	title: "Policy assistant",
	purpose: "Answer refund questions from approved evidence.",
	users: ["Support operators"],
	jobs: ["Answer policy questions"],
	inputs: ["A policy question"],
	allowedActions: ["Read approved local policy"],
	successCriteria: ["The answer names the applicable policy"],
	constraints: ["Never invent a policy"],
	openQuestions: [],
};

describe("parseCriticReply: what the judge said about the cases", () => {
	const batch = [criticCase("task-a", "How long do refunds take?"), criticCase("task-b", "Who approves a refund?")];

	it("reads a verdict per case and keeps a repair's concrete fix", () => {
		const findings = parseCriticReply(JSON.stringify({
			findings: [
				{ case: 1, verdict: "valid", reasons: [] },
				{
					case: 2,
					verdict: "repair",
					reasons: ["the check names a value the source does not state"],
					fix: { expected: "support approves it", note: "use the value the document states" },
				},
			],
		}), batch);
		expect(findings.map((finding) => finding.verdict)).toEqual(["valid", "repair"]);
		expect(findings[1]?.fix).toEqual({ expected: "support approves it", note: "use the value the document states" });
		expect(criticCounts(findings)).toEqual({ valid: 1, repair: 1, invalid: 0, unreviewed: 0 });
	});

	it("keeps an invalid verdict's reasons, and never invents one when the judge gave none", () => {
		const findings = parseCriticReply(JSON.stringify({
			findings: [
				{ case: 1, verdict: "invalid", reasons: ["the cited source holds no answer and no tool could fetch one"] },
				{ case: 2, verdict: "invalid" },
			],
		}), batch);
		expect(findings[0]?.reasons).toEqual(["the cited source holds no answer and no tool could fetch one"]);
		expect(findings[1]?.reasons).toEqual(["the critic gave no reason"]);
	});

	it("calls an unparsable reply unreviewed rather than guessing a verdict", () => {
		const findings = parseCriticReply("I looked at the cases and they seem fine to me.", batch);
		expect(findings.map((finding) => finding.verdict)).toEqual(["unreviewed", "unreviewed"]);
		expect(findings[0]?.reasons[0]).toMatch(/not the JSON it was asked for/);
	});

	it("marks a case the reply skipped unreviewed, and never a repair without a usable fix", () => {
		const findings = parseCriticReply(JSON.stringify({
			findings: [{ case: 1, verdict: "repair", reasons: [], fix: { nothing: "usable" } }],
		}), batch);
		expect(findings[0]).toEqual({ taskId: "task-a", verdict: "repair", reasons: ["the critic asked for a repair but gave no usable fix"] });
		expect(findings[1]?.verdict).toBe("unreviewed");
	});
});

describe("critiqueCases: asking the judge, and paying for the answer", () => {
	it("returns one finding per case and writes the exchange beside the receipt", async () => {
		const mock = await mockJudge(JSON.stringify({
			findings: [
				{ case: 1, verdict: "valid", reasons: [] },
				{ case: 2, verdict: "invalid", reasons: ["its world state contradicts the cited document"] },
			],
		}));
		const sidecarDir = root();
		const result = await critiqueCases({
			judge: judgeModel(mock.url),
			specText: specTextOf(spec),
			tools: ["check_policy"],
			cases: [criticCase("task-a", "How long?"), criticCase("task-b", "Who approves?")],
			sidecarDir,
		});
		expect(result.findings.map((finding) => finding.verdict)).toEqual(["valid", "invalid"]);
		expect(result.spend.calls).toBe(1);
		expect(readdirSync(sidecarDir).length).toBeGreaterThan(0);
	});

	// The critic's own outage is not a verdict on a case, and the money it cost
	// is still money: an unreviewed case says nobody read it, not that it passed.
	it("calls a batch whose call failed unreviewed, and still counts what it spent", async () => {
		const mock = await mockJudge({ httpError: { status: 500, message: "judge is down" } });
		const result = await critiqueCases({
			judge: judgeModel(mock.url),
			specText: specTextOf(spec),
			tools: [],
			cases: [criticCase("task-a", "How long?")],
			sidecarDir: root(),
		});
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0]?.verdict).toBe("unreviewed");
		expect(result.findings[0]?.reasons[0]).toMatch(/the critic could not be asked/);
		expect(result.spend.calls).toBeGreaterThan(0);
	});

	it("batches by eight, so a ninth case costs a second call", async () => {
		const mock = await mockJudge(JSON.stringify({ findings: [{ case: 1, verdict: "valid", reasons: [] }] }));
		const result = await critiqueCases({
			judge: judgeModel(mock.url),
			specText: specTextOf(spec),
			tools: [],
			cases: Array.from({ length: 9 }, (_unused, index) => criticCase(`task-${index}`, `Question ${index}`)),
			sidecarDir: root(),
			batchSize: 8,
		});
		expect(mock.requests()).toBe(2);
		// Only the first case of each batch got a finding; the rest are unreviewed.
		expect(criticCounts(result.findings)).toEqual({ valid: 2, repair: 0, invalid: 0, unreviewed: 7 });
	});
});

describe("the receipt: paid once, readable by whoever holds the hash", () => {
	it("keys the findings by the subject hash and reads them back", () => {
		const stateRoot = root();
		const subject = { kind: "corpus-draft" as const, id: "corpus-draft-x", hash: `sha256:${"b".repeat(64)}` };
		const saved = saveCriticReceipt({
			stateRoot,
			projectId: "policy",
			subject,
			judge: judgeModel("http://127.0.0.1:9901/v1"),
			findings: [{ taskId: "task-a", verdict: "invalid", reasons: ["it cannot be solved from the agent's side"] }],
			spend: { calls: 1, tokens: 100, costUsd: 0.01 },
			now: () => "2026-09-08T10:00:00.000Z",
		});
		expect(saved.counts.invalid).toBe(1);
		expect(loadCriticReceipt(stateRoot, "policy", subject)).toEqual(saved);
		expect(loadCriticReceipt(stateRoot, "policy", { hash: `sha256:${"c".repeat(64)}` })).toBeNull();
	});
});
