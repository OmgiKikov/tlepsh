import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { writeExplorerFixture, type ArmCase } from "./helpers/evidence-fixture.js";
import { collectRunDetailPage } from "../src/evidence/model.js";
import { loadRun, loadVerifiedEvalRun } from "../src/eval.js";
import { explainRun, graderFindings, runTranscript, traceFacts } from "../src/application/run-explanation.js";
import { readRunOutcome } from "../src/application/run-reading.js";
import { parseSessionJsonl } from "../src/trace.js";
import { setLanguage } from "../src/i18n.js";
import { renderRunReading } from "../src/evidence/workspace-reading.js";
import { renderTracePanel, traceNoteForModel } from "../src/builder/render/trace.js";
import { renderRunInspection } from "../src/builder/render/run-inspection.js";
import { plainPaint } from "../src/builder/render/paint.js";
import { inspectSelectedDevelopmentRun } from "../src/workbench/run-inspection.js";
import { compileImprovementBrief } from "../src/application/improvement-brief.js";
import { diagnosisPath, loadDiagnosis } from "../src/diagnosis.js";
import { createEvidenceExplorer } from "../src/evidence/server.js";
import type { GraderResult } from "../src/provenance.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); setLanguage("en"); });
function check(type: string, checkCode: string, reason: string, checkSubject?: string): GraderResult {
	return { name: type, type, checkCode, reason, passed: false, score: 0, specHash: `sha256:${"a".repeat(64)}`, ...(checkSubject ? { checkSubject } : {}) } as GraderResult;
}
function fixture(graders: GraderResult[], extra: Partial<ArmCase> = {}) {
	const f = writeExplorerFixture(() => [{ taskId: "business-case", input: "Create a ticket", answer: "Заявка W-0000 создана.", calledTool: false, graders, ...extra }]);
	roots.push(f.runsRoot);
	return { ...f, get page() { return collectRunDetailPage(f.runsRoot, f.failingRunId); } };
}
const requiredTicket = () => check("tool_called", "required-tool", "never called create_ticket", "create_ticket");
const missingTicket = () => check("world_state", "world-state", 'world at tickets.0.status is not set, expected equals "open"');

describe("human reading of recorded outcomes", () => {
	it("says that the declared ticket is absent and quotes the answer without inferring intent", () => {
		setLanguage("ru");
		const { page } = fixture([requiredTicket(), missingTicket()]);
		const reading = page.reading!;
		expect(reading.kind).toBe("world");
		expect(reading.title).toBe("Ожидаемая заявка не появилась");
		expect(reading.answerQuote?.text).toBe("Заявка W-0000 создана.");
		expect(reading.expectations.join(" ")).toContain('tickets.0.status');
		expect(reading.observations.join(" ")).toContain("не вызвал ни одного инструмента");
		expect(reading.observations).toContain("Проверка не нашла ожидаемую заявку.");
		expect(reading.observations.join(" ")).not.toContain("tickets.0.status");
		expect(reading.checks.map((item) => item.reason)).toContain('world at tickets.0.status is not set, expected equals "open"');
		expect(reading.uncertainties.join(" ")).toContain("не устанавливает первопричину");
		expect(JSON.stringify(reading)).not.toMatch(/обман|соврал|намеренно/);
	});

	it("names a contract only from the known ticket profile's recorded string expectation", () => {
		setLanguage("ru");
		const account = check("world_state", "world-state", 'world at tickets.0.account is not set, expected equals "7002"');
		const reading = fixture([requiredTicket(), account, missingTicket()]).page.reading!;
		expect(reading.observations).toContain("В состоянии теста нет заявки по договору 7002.");
		expect(reading.observations.join(" ")).not.toContain("tickets.0.");
		expect(reading.checks.map((entry) => entry.reason)).toContain(account.reason);
		expect(reading.expectations.join(" ")).toContain("tickets.0.account");
		const unrecognized = fixture([requiredTicket(), { ...account, reason: "world at tickets.0.account is not set, expected equals 7002" }]).page.reading!;
		expect(unrecognized.observations).toContain("Проверка не нашла ожидаемую заявку.");
		expect(unrecognized.observations.join(" ")).not.toContain("по договору");
		const withoutAction = fixture([account]).page.reading!;
		expect(withoutAction.observations.join(" ")).toContain("tickets.0.account");
		expect(withoutAction.observations.join(" ")).not.toContain("по договору");
	});

	it("does not call an arbitrary declared state a ticket or infer business state from a missing tool alone", () => {
		const generic = fixture([requiredTicket(), check("world_state", "world-state", 'world at basket.count is 0, expected 1')]).page.reading!;
		expect(generic.title).toBe("The action did not leave the expected result");
		expect(generic.observations.join(" ")).toContain("0");
		expect(generic.title).not.toContain("ticket");
		const tool = fixture([requiredTicket()]).page.reading!;
		expect(tool.kind).toBe("tool");
		expect(tool.title).toContain("create_ticket");
		expect(tool.uncertainties.join(" ")).toContain("does not establish the final business state");
	});

	it("treats a missing world declaration and evaluator abstention as uncertain measurement", () => {
		const undeclared = fixture([check("world_state", "world-state", "case declares no world")]).page.reading!;
		expect(undeclared.kind).toBe("uncertain");
		expect(undeclared.title).toContain("does not define how to verify");
		const judge = { ...check("judge", "semantic-rubric", "judge declined"), abstained: true };
		const f = fixture([judge]);
		const uncertain = f.page.reading!;
		expect(uncertain.kind).toBe("uncertain");
		expect(uncertain.title).toBe("The evaluator could not decide");
		const brief = compileImprovementBrief(f.runsRoot, loadDiagnosis(f.runsRoot, f.baselineEvalRunId));
		expect(brief.modes[0]?.decision).toBe("stabilize-and-rerun");
	});

	it("distinguishes retrieval failure from a failed answer check after the required source was returned", () => {
		const source = check("cites_source", "cites-source", "the answer neither cites returns.md#0 nor overlaps it: token-f1 = 0.00, below threshold 0.30", "returns.md#0");
		const f = fixture([source]);
		expect(f.page.reading?.kind).toBe("retrieval");
		const run = loadRun(f.runsRoot, f.failingRunId);
		const read = (id: string) => {
			const messages = parseSessionJsonl([
				{ type: "message", message: { role: "user", content: "When can I return it?" } },
				{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "search", name: "kb_search", arguments: { query: "returns" } }] } },
				{ type: "message", message: { role: "toolResult", toolCallId: "search", toolName: "kb_search", content: JSON.stringify({ schemaVersion: 1, chunks: [{ id, path: "returns.md", text: "Returns accepted within 30 days", score: 3 }] }) } },
				{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Seven days only." }] } },
			].map((line) => JSON.stringify(line)).join("\n"));
			return readRunOutcome(explainRun({ run, graders: graderFindings(run), facts: traceFacts(messages), messages, modes: [], flip: null }), runTranscript(messages));
		};
		const found = read("returns.md#0");
		expect(found.title).toBe("The needed source was returned, but the answer failed the source check");
		expect(found.observations.join(" ")).toContain("contains a source required by this case");
		expect(found.observations.join(" ")).toContain("neither cites returns.md#0 nor has enough text overlap");
		expect(found.answerQuote?.text).toBe("Seven days only.");
		expect(found.uncertainties.join(" ")).toContain("not whether every claim follows");
		const missed = read("shipping.md#0");
		expect(missed.title).toBe("The search did not return the needed source");
		expect(missed.observations.join(" ")).not.toContain("contains a source required");
	});

	it("does not blame an answer when execution failed or guess from unknown reason grammar", () => {
		const error = fixture([], { status: "error", error: "command Target exited with code 2" }).page.reading!;
		expect(error.kind).toBe("execution");
		expect(error.answerQuote).toBeNull();
		expect(error.uncertainties.join(" ")).toContain("does not establish a behavioral failure");
		const unknown = fixture([check("world_state", "world-state", "a future check grammar we do not interpret")]).page.reading!;
		expect(unknown.kind).toBe("check");
		expect(unknown.expectations).toEqual([]);
		expect(unknown.checks[0]?.reason).toBe("a future check grammar we do not interpret");
		const { checkCode: _noCanonicalCode, specHash: _noCanonicalSpec, ...legacyUnknown } = check("future_check", "world-state", "an unknown grader failed");
		const unrecognized = fixture([legacyUnknown]).page.reading!;
		expect(unrecognized.kind).toBe("check");
		expect(unrecognized.checks[0]?.reason).toBe("an unknown grader failed");
	});

	it("keeps missing traces and shortened quotes explicit and does not invent an already verified change", () => {
		const { page } = fixture([requiredTicket()], { answer: `sk-proj-${"a".repeat(48)} ${"x".repeat(500)}` });
		const explanation = { ...page.explanation, flip: null };
		const reading = readRunOutcome(explanation, page.transcript);
		expect(reading.answerQuote?.clipped).toBe(true);
		expect(reading.answerQuote!.text.length).toBeLessThanOrEqual(281);
		expect(reading.answerQuote?.text).not.toContain(`sk-proj-${"a".repeat(48)}`);
		expect(renderRunReading(reading)).toContain("No verified change is linked to this case yet");
		const unavailable = readRunOutcome(explanation, null);
		expect(unavailable.answerQuote).toBeNull();
		expect(unavailable.uncertainties.join(" ")).toContain("verified conversation is unavailable");
		const partial = readRunOutcome(explanation, { ...page.transcript!, truncated: true });
		expect(partial.uncertainties.join(" ")).toContain("excerpt may omit context");
	});

	it("shares the same reading with terminal traces and exact Workbench inspection", () => {
		setLanguage("ru");
		const f = fixture([requiredTicket(), missingTicket()]);
		const page = f.page;
		const inspected = inspectSelectedDevelopmentRun({ runsRoot: f.runsRoot, evaluation: loadVerifiedEvalRun(f.runsRoot, f.baselineEvalRunId), targetId: "ombudsman", runId: f.failingRunId });
		expect(inspected.reading?.title).toBe(page.reading?.title);
		expect(inspected.reading?.observations).toEqual(page.reading?.observations);
		expect(inspected.reading?.answerQuote).toEqual(page.reading?.answerQuote);
		for (const rendered of [renderTracePanel(page, plainPaint).join("\n"), renderRunInspection(inspected, plainPaint).join("\n"), traceNoteForModel(page)]) {
			expect(rendered).toContain("Ожидаемая заявка не появилась");
			expect(rendered).toContain("tickets.0.status");
			expect(rendered.replace(/\s+/g, " ")).toContain("не устанавливает первопричину");
		}
	});

	it("escapes hostile recorded text and keeps a repeated measurement distinct from a changed agent", () => {
		const f = fixture([requiredTicket()], { answer: '<script>alert("claim")</script>' });
		const reading = f.page.reading!;
		const rendered = renderRunReading(reading);
		expect(rendered).toContain("&lt;script&gt;");
		expect(rendered).not.toContain("<script>");
		expect(reading.comparison).not.toBeNull();
		expect(rendered).toContain(`/candidates/${reading.comparison!.candidateId}`);
		expect(rendered).toContain("Read the complete comparison before accepting");
		expect(renderRunReading({ ...reading, comparison: { ...reading.comparison!, mode: "aa-calibration" } })).toContain("repeated measurement of the same revision");
	});

	it("serves source-only, unknown-check and abstention failures through the real workspace endpoint", async () => {
		const cases: Array<{ grader: GraderResult; title: string }> = [
			{ grader: check("cites_source", "cites-source", "the answer neither cites returns.md#0 nor overlaps it: token-f1 = 0.00, below threshold 0.30", "returns.md#0"), title: "The recorded conversation contains no source search" },
			{ grader: { name: "future check", type: "future_check", passed: false, score: 0, reason: "recorded failure" }, title: "A recorded check did not pass" },
			{ grader: { ...check("judge", "semantic-rubric", "judge declined"), abstained: true }, title: "The evaluator could not decide" },
		];
		for (const item of cases) {
			const f = fixture([item.grader]);
			const server = createEvidenceExplorer({ runsRoot: f.runsRoot });
			try {
				const address = await server.listen();
				const response = await fetch(`${address.url}/evals/${f.baselineEvalRunId}?run=${f.failingRunId}`);
				expect(response.status).toBe(200);
				const html = await response.text();
				expect(html).toContain(`<h3>${item.title}</h3>`);
				expect(html).toContain('class="w-reading"');
			} finally {
				await server.close();
			}
		}
	});

	it("keeps an incompatible stored diagnosis unchanged and gives a recovery page without weakening integrity checks", async () => {
		const f = fixture([check("cites_source", "cites-source", "source check failed", "returns.md#0")]);
		const path = diagnosisPath(f.runsRoot, f.baselineEvalRunId);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		const priorClassification = `${JSON.stringify({ ...saved, status: "healthy" })}\n`;
		writeFileSync(path, priorClassification);
		const server = createEvidenceExplorer({ runsRoot: f.runsRoot });
		try {
			const address = await server.listen();
			const response = await fetch(`${address.url}/evals/${f.baselineEvalRunId}`);
			expect(response.status).toBe(409);
			expect(response.headers.get("content-type")).toContain("text/html");
			expect(await response.text()).toContain("Run a new evaluation and diagnosis");
			expect(readFileSync(path, "utf8")).toBe(priorClassification);
			writeFileSync(path, JSON.stringify({ ...saved, inputHash: `sha256:${"f".repeat(64)}` }));
			const altered = await fetch(`${address.url}/evals/${f.baselineEvalRunId}`);
			expect(altered.status).toBe(422);
			expect(await altered.text()).toBe("Evidence report failed integrity or visibility checks.\n");
		} finally {
			await server.close();
		}
	});
});
