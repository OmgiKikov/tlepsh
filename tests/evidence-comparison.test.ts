import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectComparePage, collectRunDetailPage, MAX_COMPARE_PREVIEW_CASES } from "../src/evidence/model.js";
import { renderComparePage, renderRunDetailPage } from "../src/evidence/pages.js";
import { setLanguage } from "../src/i18n.js";
import { SEALED_SENTINEL, writeExplorerFixture, type ArmCase } from "./helpers/evidence-fixture.js";

const roots: string[] = [];
function fixture(cases?: (candidate: boolean) => ArmCase[]) {
	const value = writeExplorerFixture(cases);
	roots.push(value.runsRoot);
	return value;
}
function task(id: string, passed: boolean, overrides: Partial<ArmCase> = {}): ArmCase {
	return {
		taskId: id, input: `Question ${id}`, answer: passed ? "Correct recorded answer" : "Wrong recorded answer", calledTool: false,
		graders: [{ name: "answer", type: "output_contains", passed, score: passed ? 1 : 0, reason: passed ? "matched" : "did not match" }],
		...overrides,
	};
}
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	setLanguage("en");
});

describe("verified before/after evidence", () => {
	it("shows bounded real answers, regressions first even when improvements dominate", () => {
		const f = fixture(candidate => [
			...Array.from({ length: 9 }, (_, i) => task(`improvement-${i}`, candidate)),
			task("z-regression", !candidate),
		]);
		const model = collectComparePage(f.runsRoot, f.candidateId);
		expect(model.examples).toHaveLength(MAX_COMPARE_PREVIEW_CASES);
		expect(model.examples[0]?.taskId).toBe("z-regression");
		expect(model.examples[0]?.baseline?.answer).toBe("Correct recorded answer");
		expect(model.examples[0]?.candidate?.answer).toBe("Wrong recorded answer");
		const html = renderComparePage(model);
		expect(html).toContain("Showing 6 of 10 task pairs");
		expect(html).toContain(`/runs/${model.examples[0]?.candidate?.runId}`);
		expect(html).not.toContain(SEALED_SENTINEL);
	});

	it("pairs the earliest matching repetition, not a favourable candidate answer", () => {
		const f = fixture(candidate => candidate
			? [task("repeated", true, { repetitionIndex: 1, answer: "Later success" }), task("repeated", false, { repetitionIndex: 0, answer: "First failure" })]
			: [task("repeated", true, { repetitionIndex: 0, answer: "Original first answer" }), task("repeated", false, { repetitionIndex: 1 })]);
		const sample = collectComparePage(f.runsRoot, f.candidateId).examples[0];
		expect(sample?.baseline?.repetitionIndex).toBe(0);
		expect(sample?.candidate?.repetitionIndex).toBe(0);
		expect(sample?.candidate?.answer).toBe("First failure");
		expect(sample?.baselineScore).toBe(0.5);
		expect(sample?.candidateScore).toBe(0.5);
	});

	it("does not dress an excluded infrastructure error as a behavioural improvement", () => {
		const f = fixture();
		const model = collectComparePage(f.runsRoot, f.candidateId);
		const excluded = model.examples.find(example => example.taskId === "task_003");
		expect(excluded?.exclusion).toBe("infrastructure");
		expect(excluded?.baseline?.outcome).toBe("error");
		const html = renderComparePage(model);
		const card = html.split('<article class="example">').find(part => part.includes('<h3>task_003</h3>'))?.split("</article>")[0];
		expect(card).toContain("Excluded: execution error");
		expect(card).toContain("these answers do not establish an improvement");
		expect(card).not.toContain("+100 pts");
		expect(collectRunDetailPage(f.runsRoot, f.erroredRunId).explanation.flip).toBeNull();
	});

	it("keeps incompatible execution conditions visible and suppresses improvement claims", () => {
		const f = fixture(candidate => [task("different-runtime", candidate, { costUsd: candidate ? null : 0.01 })]);
		const model = collectComparePage(f.runsRoot, f.candidateId);
		expect(model.comparability).toBe("invalid");
		expect(model.developmentLine).toContain("cannot establish an improvement");
		expect(model.confidence).toBeNull();
		const html = renderComparePage(model);
		const finding = html.split('<div class="finding">')[1]?.split("</div>")[0];
		expect(finding).toContain("differing axes: execution");
		const examples = html.split('<div class="examples">')[1]?.split('<section>')[0];
		expect(examples).toContain("Not comparable");
		expect(examples).not.toContain("+100 pts");
		expect(collectRunDetailPage(f.runsRoot, f.failingRunId).explanation.flip).toBeNull();
	});

	it("uses score direction consistently when partial credit improves without a passing answer", () => {
		const f = fixture(candidate => [task("partial", false, { graders: [{
			name: "rubric", type: "output_contains", passed: false, score: candidate ? 0.8 : 0.2, reason: "partial credit",
		}] })]);
		const html = renderComparePage(collectComparePage(f.runsRoot, f.candidateId));
		expect(html).toContain("+60 pts");
		expect(html).toContain("↑ improved");
		expect(html).not.toContain("= unchanged");
	});

	it("escapes and redacts recorded content and keeps unavailable cost unknown", () => {
		const f = fixture(candidate => [task("unsafe-text", candidate, {
			input: '<script>alert("input")</script>',
			answer: 'Reply <img src=x onerror=alert(1)> sk-proj-1234567890abcdefghijklmnop',
			costUsd: null,
		})]);
		const model = collectComparePage(f.runsRoot, f.candidateId);
		expect(model.resources.costRatio).toBeNull();
		const html = renderComparePage(model);
		expect(html).toContain("&lt;script&gt;");
		expect(html).not.toContain('<script>alert("input")');
		expect(html).not.toContain("<img src=x");
		expect(html).not.toContain("sk-proj-1234567890abcdefghijklmnop");
		expect(collectRunDetailPage(f.runsRoot, f.failingRunId).run.metrics.costUsd).toBeNull();
	});

	it("never renders a trace whose recorded bytes were changed", () => {
		const f = fixture();
		const path = join(f.runsRoot, f.failingRunId, "session.jsonl");
		writeFileSync(path, readFileSync(path, "utf8").replace("Ответ без проверки.", "TAMPERED_ANSWER"));
		const model = collectComparePage(f.runsRoot, f.candidateId);
		expect(model.examples.find(example => example.taskId === "task_001")?.baseline?.answer).toBeNull();
		expect(renderComparePage(model)).not.toContain("TAMPERED_ANSWER");
	});

	it("uses the same Russian explanation as the terminal and labels the relative exam", () => {
		setLanguage("ru");
		const f = fixture();
		const run = collectRunDetailPage(f.runsRoot, f.failingRunId);
		const html = renderRunDetailPage(run);
		for (const sentence of run.explanation.sentences) {
			expect(html).toContain(sentence.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!));
		}
		const compare = renderComparePage(collectComparePage(f.runsRoot, f.candidateId));
		expect(compare).toContain("Что изменилось в агенте");
		expect(compare).toContain("До и после");
		expect(compare).toContain("не абсолютная оценка готовности");
		expect(compare).not.toContain(SEALED_SENTINEL);
	});
});
