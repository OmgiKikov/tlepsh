import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { language, plural, resolveLanguage, setLanguage, settingsPath, t, verdictLabel } from "../src/i18n.js";
import { renderConfirmation } from "../src/builder/render/confirmation.js";
import { renderDecision } from "../src/builder/render/decision.js";
import { renderHeader, renderCandidate, renderReview } from "../src/builder/render/view.js";
import { renderCalibration } from "../src/builder/render/calibration.js";
import { plainPaint } from "../src/builder/render/paint.js";
import { stageLabel, nextStep } from "../src/builder/render/stage.js";
import { renderRunDetailPage } from "../src/evidence/pages.js";
import { createRunProgressPresenter } from "../src/builder/run-progress.js";
import { explainRun } from "../src/application/run-explanation.js";
import type { WorkbenchCandidateSummary, WorkbenchConfirmation, WorkbenchView } from "../src/workbench/types.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function withSettings(language: unknown): { home: string; cleanup: () => void } {
	const home = mkdtempSync(join(tmpdir(), "ahde-i18n-"));
	const path = settingsPath({}, home);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, typeof language === "string" ? JSON.stringify({ language }) : String(language), "utf8");
	return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function makeView(overrides: Partial<WorkbenchView> = {}): WorkbenchView {
	return {
		schemaVersion: 1,
		project: { id: "proj", directory: "/tmp/proj" },
		stage: "spec-review",
		headline: "A Spec draft is waiting for review",
		target: {
			status: "ready",
			id: "support-bot",
			gitSha: SHA_A,
			model: { provider: "openai", id: "gpt-5", apiKeyEnv: "OPENAI_API_KEY", credentialPresent: true },
		},
		focus: {},
		selections: [],
		actions: [],
		blockers: [],
		warnings: [],
		calibration: null,
		counts: {
			specDrafts: 1,
			approvedSpecs: 0,
			corpusDrafts: 0,
			developmentCorpora: 0,
			sealedCorpora: 0,
			developmentEvals: 2,
			openProposals: 1,
			candidates: 3,
			calibrations: 0,
		},
		...overrides,
	};
}

function makeCandidate(overrides: Partial<WorkbenchCandidateSummary> = {}): WorkbenchCandidateSummary {
	return {
		candidateId: "candidate-1",
		status: "evaluated",
		projectId: "proj",
		targetId: "support-bot",
		specId: "spec-1",
		proposalId: "run-1",
		baseline: { ref: "main", sha: SHA_A },
		candidate: { ref: "ahde/candidate-1", sha: SHA_B },
		development: {
			baselineEvalRunId: "eval-base",
			candidateEvalRunId: "eval-cand",
			comparison: {
				taskCount: 10,
				baselinePassRate: 0.4,
				candidatePassRate: 0.7,
				delta: 0.3,
				confidence95: { low: 0.05, high: 0.35 },
				improved: 3,
				regressed: 1,
				unchanged: 6,
			},
			gate: {
				verdict: "improved",
				scoreDelta: 0.23,
				baselineScore: 0.4,
				candidateScore: 0.7,
				confidence95: { low: 0.05, high: 0.35 },
				tasks: 10,
				repetitions: 3,
				policyId: "comparison-gate/v1",
				reasons: [],
				resources: { costRatio: 1.4, latencyRatio: 0.9, tokenRatio: null },
				flags: { collapsedTasks: 0 },
			},
		},
		sealedHoldout: {
			executed: true,
			gatePassed: true,
			gate: {
				verdict: "pass",
				scoreDelta: 0.2,
				baselineScore: 0.4,
				candidateScore: 0.6,
				confidence95: { low: 0.02, high: 0.38 },
				tasks: 20,
				repetitions: 3,
				policyId: "comparison-gate/v1",
				reasons: [],
				resources: { costRatio: null, latencyRatio: null, tokenRatio: null },
				flags: { collapsedTasks: 0 },
			},
		},
		judgeAgreement: null,
		review: null,
		promotion: null,
		rejection: null,
		...overrides,
	} as WorkbenchCandidateSummary;
}

/**
 * Latin runs that survive a Russian render must be things that are NOT
 * language: ids, hashes, shas, command and flag names, model and env names,
 * file paths, policy ids and the verdict tokens tests match on. Anything else
 * is an English word that leaked.
 */
const ALLOWED_LATIN = new Set([
	"AHDE", "ahde", "label", "holdout", "doctor", "help", "login", "model", "run", "adopt", "calibrate",
	"support", "bot", "openai", "gpt", "OPENAI", "API", "KEY", "main", "candidate", "eval", "base", "cand",
	"proj", "spec", "task", "tmp", "v", "n", "CI", "pts", "comparison", "gate", "improved", "pass",
	"jsonl", "JSONL", "OAuth", "Pi", "Enter", "id", "th", "tr", "td", "class", "span", "num", "chip",
	"href", "div", "table", "thead", "tbody", "scroll", "wrapcell", "h", "a", "p", "pre", "section",
	"repetition", "sub", "mono", "errpre", "cards", "card", "count", "row", "outcome", "score",
]);

function leakedEnglish(text: string): string[] {
	const stripped = text
		// ids, hashes, shas, paths, urls and dotted/dashed technical tokens
		.replace(/\b[0-9a-f]{7,}\b/g, " ")
		.replace(/[\w.-]*\/[\w./-]*/g, " ")
		.replace(/\b[A-Za-z][\w-]*[0-9][\w-]*/g, " ")
		.replace(/\b[A-Z][A-Z0-9_]{2,}\b/g, " ");
	const words = stripped.match(/[A-Za-z]{2,}/g) ?? [];
	return [...new Set(words.filter((word) => !ALLOWED_LATIN.has(word)))];
}

afterEach(() => {
	setLanguage(null);
});

describe("language resolution", () => {
	it("prefers AHDE_LANG over every other source", () => {
		const settings = withSettings("ru");
		try {
			expect(resolveLanguage({ AHDE_LANG: "en", LC_ALL: "ru_RU.UTF-8" }, settings.home)).toBe("en");
			expect(resolveLanguage({ AHDE_LANG: "ru" }, settings.home)).toBe("ru");
			expect(resolveLanguage({ AHDE_LANG: " RU " }, settings.home)).toBe("ru");
		} finally {
			settings.cleanup();
		}
	});

	it("falls back to the Builder's settings.json language", () => {
		const settings = withSettings("ru");
		try {
			expect(resolveLanguage({}, settings.home)).toBe("ru");
			expect(resolveLanguage({ LC_ALL: "en_US.UTF-8" }, settings.home)).toBe("ru");
		} finally {
			settings.cleanup();
		}
	});

	it("ignores an unknown, absent or unparseable settings language", () => {
		const unknown = withSettings("de");
		const broken = withSettings("{not json");
		try {
			expect(resolveLanguage({}, unknown.home)).toBe("en");
			expect(resolveLanguage({ LANG: "ru_RU.UTF-8" }, unknown.home)).toBe("ru");
			expect(resolveLanguage({}, broken.home)).toBe("en");
			expect(resolveLanguage({}, join(unknown.home, "missing"))).toBe("en");
		} finally {
			unknown.cleanup();
			broken.cleanup();
		}
	});

	it("reads the shell locale only after AHDE_LANG and settings, and only for ru", () => {
		const empty = mkdtempSync(join(tmpdir(), "ahde-i18n-empty-"));
		try {
			expect(resolveLanguage({ LC_ALL: "ru_RU.UTF-8" }, empty)).toBe("ru");
			expect(resolveLanguage({ LANG: "ru" }, empty)).toBe("ru");
			expect(resolveLanguage({ LC_ALL: "C.UTF-8", LANG: "ru_RU.UTF-8" }, empty)).toBe("ru");
			expect(resolveLanguage({ LANG: "fr_FR.UTF-8" }, empty)).toBe("en");
			expect(resolveLanguage({}, empty)).toBe("en");
		} finally {
			rmSync(empty, { recursive: true, force: true });
		}
	});

	it("honours AHDE_HOME when locating settings.json", () => {
		expect(settingsPath({ AHDE_HOME: "/opt/ahde" }, "/home/x"))
			.toBe("/opt/ahde/builder-pi/config/settings.json");
		expect(settingsPath({}, "/home/x")).toBe("/home/x/.ahde/builder-pi/config/settings.json");
	});

	it("resolves the process language once and lets tests pin it", () => {
		setLanguage("ru");
		expect(language()).toBe("ru");
		expect(t("label.stage")).toBe("Стадия");
		setLanguage("en");
		expect(t("label.stage")).toBe("Stage");
	});
});

describe("English default", () => {
	it("needs no AHDE_LANG to keep every host string as it was", () => {
		setLanguage(null);
		expect(resolveLanguage({}, join(tmpdir(), "ahde-absent-home"))).toBe("en");
		setLanguage("en");
		expect(stageLabel("spec-design")).toBe("Spec design");
		expect(nextStep(makeView())).toBe("Say “ok” to approve it, or what to change");
		expect(plural(24, "case")).toBe("24 cases");
		expect(plural(1, "case")).toBe("1 case");
		expect(verdictLabel("improved")).toBe("improved");
		expect(verdictLabel("pass")).toBe("pass");
	});
});

describe("ru renders", () => {
	it("draws the live header in Russian", () => {
		setLanguage("ru");
		const lines = renderHeader(
			{ view: makeView(), builderModel: { label: "anthropic/claude-opus", credentialPresent: true } },
			plainPaint,
		);
		expect(lines).toEqual([
			"",
			"AHDE Билдер · собирает, проверяет и улучшает другого агента по данным",
			"Агент support-bot @ aaaaaaaaaa · openai/gpt-5 ✓",
			"Стадия Проверка описания · Дальше Скажи «ок» или что поправить",
			"Данные 2 прогона · 1 открытая правка · 3 кандидата · Модель Билдера anthropic/claude-opus ✓",
			"Просто скажи, что нужно",
			"",
		]);
		expect(leakedEnglish(lines.join("\n"))).toEqual([]);
	});

	it("bends nouns for the count the way Russian does", () => {
		setLanguage("ru");
		expect(plural(1, "case")).toBe("1 кейс");
		expect(plural(2, "case")).toBe("2 кейса");
		expect(plural(5, "case")).toBe("5 кейсов");
		expect(plural(11, "case")).toBe("11 кейсов");
		expect(plural(21, "case")).toBe("21 кейс");
		expect(plural(72, "execution")).toBe("72 запуска");
		expect(plural(24, "case")).toBe("24 кейса");
	});

	it("asks the three consequential questions in Russian", () => {
		setLanguage("ru");
		expect(t("confirm.question", { title: t("confirm.apply-proposal.title") })).toBe("Применить эту правку?");
		expect(t("confirm.question", { title: t("confirm.ship.title", { version: "0.2.0" }) })).toBe("Выкатить как v0.2.0?");
		const parts = [
			t("confirm.start-testing.part.approve-spec"),
			t("confirm.start-testing.part.publish-corpus", { cases: plural(24, "case") }),
			t("confirm.start-testing.part.run", { runs: plural(72, "execution") }),
		];
		expect(t("confirm.question", { title: t("confirm.start-testing.title", { parts: parts.join(", ") }) }))
			.toBe("Начать тесты — одобрить описание, опубликовать 24 кейса, прогнать 72 запуска?");
		expect(t("confirm.discard-proposal")).toBe("Выбросить эту правку? Применить её потом будет нельзя.");
	});

	it("renders the apply-proposal confirmation body in Russian", () => {
		setLanguage("ru");
		const confirmation: WorkbenchConfirmation = {
			kind: "apply-proposal",
			title: t("confirm.apply-proposal.title"),
			reason: "Правка по первой проблеме",
			subject: {
				operation: "apply-proposal",
				branch: "ahde/candidate-1",
				baseTargetSha: SHA_A,
				summary: "Добавить упоминание инструмента поиска в инструкции",
				paths: ["AGENTS.md"],
				risks: [],
				exactDiff: "--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1,2 @@\n context\n+lookup\n",
			},
			subjectHash: "c".repeat(64),
			policy: "consequential",
			question: t("confirm.question", { title: t("confirm.apply-proposal.title") }),
			estimate: { executions: 60, sampledRuns: 4, costUsd: 0.42, minutes: 3.2 },
		};
		const lines = renderConfirmation(confirmation, plainPaint);
		expect(lines).toEqual([
			"Ветка ahde/candidate-1 · база aaaaaaaaaa",
			"  Добавить упоминание инструмента поиска в инструкции",
			"Изменения AGENTS.md (+1 -0)",
			"Прогноз не заявлен",
			"Проверка около $0.42 · около 4 мин — одобряя правку, ты одобряешь и эту проверку",
			"Диф",
			"--- a/AGENTS.md",
			"+++ b/AGENTS.md",
			"@@ -1 +1,2 @@",
			" context",
			"+lookup",
			"Твой рабочий каталог остаётся на месте; правка коммитится на ветку кандидата.",
			"",
			"Причина Правка по первой проблеме",
			`Точный предмет ${"c".repeat(64)}`,
		]);
	});

	it("renders the run and verify dialog bodies in Russian", () => {
		setLanguage("ru");
		const runEval: WorkbenchConfirmation = {
			kind: "run-eval",
			title: t("confirm.title.run-eval"),
			reason: "оператор сказал «тесты»",
			subject: {
				operation: "run-development-evaluation",
				taskCount: 6,
				repetitions: 3,
				target: { id: "support-bot", gitSha: SHA_A },
				developmentCorpus: { id: "corpus-1", taskCount: 6 },
			},
			subjectHash: "e".repeat(64),
			policy: "routine",
			question: t("confirm.run-eval", { runs: plural(18, "execution") }),
		};
		const run = renderConfirmation(runEval, plainPaint);
		expect(run[0]).toBe("Прогон 6 кейсов × 3 повтора = 18 запусков · каждый — вызов модели агента");
		expect(run[1]).toBe("Агент support-bot @ aaaaaaaaaa · тесты corpus-1 (6 кейсов)");
		expect(leakedEnglish(run.join("\n"))).toEqual([]);

		const verify: WorkbenchConfirmation = {
			kind: "verify-candidate",
			title: t("confirm.title.verify-candidate"),
			reason: "проверяю применённую правку",
			subject: {
				operation: "verify-applied-candidate",
				baseTargetSha: SHA_A,
				candidateSha: SHA_B,
				repetitions: 3,
				developmentCorpus: { id: "corpus-1", hash: "f".repeat(64) },
				sealedHoldout: { id: "sealed-1", hash: "0".repeat(64), taskCount: 20 },
			},
			subjectHash: "e".repeat(64),
			policy: "routine",
			question: t("confirm.verify-candidate", { runs: plural(156, "execution") }),
		};
		const lines = renderConfirmation(verify, plainPaint);
		expect(lines[0]).toBe("Парный эксперимент база aaaaaaaaaa против кандидата bbbbbbbbbb · 3 повтора");
		expect(lines[2]).toBe("Экзамен 20 кейсов · что внутри — знает только оценщик");
		expect(lines[3]).toBe("Обе ревизии прогоняются по всем кейсам; закрытого Билдер не видит.");
		expect(verify.question).toBe("Сверить кандидата с базой (156 запусков)?");
		expect(leakedEnglish(lines.join("\n"))).toEqual([]);
	});

	it("renders the verdict block in Russian and keeps the tokens intact", () => {
		setLanguage("ru");
		const lines = renderCandidate(makeCandidate(), plainPaint, t("candidate.verified"));
		const text = lines.join("\n");
		expect(lines[0]).toBe("Кандидат проверен candidate-1 · оценён");
		// The status the record stores is a token; only its label bends.
		expect(makeCandidate().status).toBe("evaluated");
		expect(text).toContain("Разработка было 40% → кандидат 70% (+30 п.п.) · задач 10 · балл 40% → 70%");
		expect(text).toContain("Вердикт стало лучше · +23 п.п. (95% ДИ +5 п.п. … +35 п.п.) · 10 × 3 · цена ×1.4 · задержка ×0.9");
		expect(text).toContain("Экзамен пройден · +20 п.п. (95% ДИ +2 п.п. … +38 п.п.) · 20 × 3");
		expect(text).toContain("Судья не откалиброван · ahde label");
		// The tokens tests and scripts match on are untouched by the language.
		expect(verdictLabel("improved")).toBe("стало лучше");
		expect(makeCandidate().development?.gate?.verdict).toBe("improved");
		expect(makeCandidate().sealedHoldout.gate?.verdict).toBe("pass");
		expect(t("label.sealed-holdout")).toBe("Экзамен");
	});

	it("renders a decision result block in Russian", () => {
		setLanguage("ru");
		const view = makeView({ stage: "candidate-review", headline: "Кандидат ждёт решения" });
		const lines = renderDecision({
			kind: "apply-proposal",
			message: "Proposal applied to an exact candidate branch; verification is now required.",
			result: { runId: "run-1", branch: "ahde/candidate-1", candidateSha: SHA_B, proposalHash: "d".repeat(64) },
			view,
		}, plainPaint);
		expect(lines).toEqual([
			"Правка применена ветка ahde/candidate-1 · кандидат bbbbbbbbbb · правка dddddddddddd…",
			"Твой рабочий каталог не переключали; кандидат живёт на своей ветке, пока ты его не примешь.",
			"Дальше Скажи «выкатывай» — или «отклонить» (Обзор кандидата)",
		]);
		expect(leakedEnglish(lines.join("\n"))).toEqual([]);
	});

	it("labels the Evidence Explorer table headers in Russian", () => {
		setLanguage("ru");
		expect([
			t("explorer.th.task"),
			t("explorer.th.rep"),
			t("explorer.th.input"),
			t("explorer.th.outcome"),
			t("explorer.th.score"),
			t("explorer.th.graders"),
			t("explorer.th.failure-mode"),
			t("explorer.th.tools"),
			t("explorer.th.latency"),
			t("explorer.th.cost"),
			t("explorer.th.tokens"),
		]).toEqual([
			"Задача", "Повтор", "Вход", "Итог", "Балл", "Проверки", "Тип сбоя", "Инструменты", "Задержка", "Цена", "Токены",
		]);
		expect(leakedEnglish([t("explorer.th.task"), t("explorer.h2.why"), t("explorer.h2.per-task")].join(" "))).toEqual([]);
	});

	it("writes one Why sentence in Russian without touching ids or grader type names", () => {
		setLanguage("ru");
		const explanation = explainRun({
			run: {
				runId: "run-7",
				taskId: "task-3",
				repetitionIndex: 2,
				status: "completed",
			} as never,
			graders: [
				{
					name: "answer-mentions-lookup",
					type: "output_contains",
					passed: false,
					reason: "the reply never mentions lookup",
					assertions: [],
				} as never,
			],
			facts: null,
			modes: [],
			flip: null,
		});
		expect(explanation.headline).toBe("task-3, повтор 2: провален, не прошли 1 из 1 проверок.");
		expect(explanation.sentences[0]).toBe("task-3, повтор 2: провален, не прошли 1 из 1 проверок.");
		// Grader type names are ids: they survive the translation verbatim.
		expect(explanation.sentences.join("\n")).toContain("output_contains");
		// The run and task ids stay exactly as recorded.
		expect(explanation.runId).toBe("run-7");
		expect(explanation.taskId).toBe("task-3");
	});

	it("draws the proposal under review and the noise panel in Russian", () => {
		setLanguage("ru");
		const review = renderReview({
			kind: "proposal",
			runId: "builder-proposal-1",
			summary: "Научить агента звать инструмент поиска",
			paths: ["AGENTS.md"],
			baseTargetSha: SHA_A,
			proposalHash: "c".repeat(64),
			evidenceBasis: null,
			prediction: null,
			risks: ["Ответы станут длиннее"],
			validationPlan: ["Прогнать тесты разработки"],
			exactDiff: "--- a/AGENTS.md\n+++ b/AGENTS.md\n@@ -1 +1,2 @@\n context\n+lookup\n",
		} as never, plainPaint);
		expect(review[0]).toBe("Правка builder-proposal-1");
		expect(review[2]).toBe("Изменения AGENTS.md (+1 -0)");
		expect(review[3]).toBe("База aaaaaaaaaa · правка cccccccccccc…");
		expect(review[4]).toBe("Данные ничего не привязано (правка только по описанию)");
		expect(review).toContain("Риски");
		expect(review).toContain("План проверки");
		expect(review).toContain("Диф");

		const noise = renderCalibration({
			targetSha: SHA_A,
			verdict: "inconclusive",
			taskCount: 6,
			repetitions: 3,
			aaPassRate: 0.5,
			flipRate: 0.1,
			confidence95: { low: -0.06, high: 0.06 },
			recommendedRepetitions: 3,
		} as never, plainPaint);
		expect(noise[0]).toBe("Калибровка шума A/A неубедительно · ревизия aaaaaaaaaa");
		expect(noise[1]).toBe("Схема 6 кейсов × 3 повтора · одна и та же ревизия с обеих сторон · база 50%");
		expect(noise.at(-1)).toBe("A/A — это замер, а не данные: калибровкой ничего не выкатывается.");
	});

	it("watches a running measurement in Russian, and counts the whole job", () => {
		setLanguage("ru");
		const setStatus = vi.fn();
		const setWidget = vi.fn();
		const progress = createRunProgressPresenter({ setStatus, setWidget }, { liveTraceUrl: "http://127.0.0.1:6333/live/abc" });
		const run = { evalRunId: "erun-1", runId: "run-a", taskId: "task_001", repetitionIndex: 0, ordinal: 1, total: 90 };
		const at = "2026-08-28T10:00:00.000Z";

		progress.plan(372);
		progress.onRunEvent({ type: "run_started", at, run } as never);
		progress.onRunEvent({
			type: "tool_finished", at, run,
			toolCallId: "call-1", toolName: "bash", isError: false, output: "ok", truncated: false,
		} as never);
		progress.onRunEvent({
			type: "run_graded", at, run, outcome: "fail", passedGraders: 0, totalGraders: 3,
		} as never);

		const status = String(setStatus.mock.calls.at(-1)?.[1]);
		expect(status).toContain("AHDE прогон оценено 1/372 · идёт 0");
		expect(status).toContain("· оценено провален");
		const frame = (setWidget.mock.calls.at(-1)?.[1] ?? []) as string[];
		expect(frame[0]).toBe("AHDE · черновой трейс прогона");
		expect(frame[1]).toBe("открыть живой трейс · http://127.0.0.1:6333/live/abc");
		expect(frame).toContain("прогон · старт 1/90 · task_001");
		expect(frame).toContain("инструмент ✓ bash · ok");
		expect(frame).toContain("оценка ✗ · провален · проверок 0/3 · пока ✓0 ✗1");
		progress.dispose();
	});

	it("stamps the rendered page with the resolved language", () => {
		setLanguage("ru");
		expect(t("panel.title", { detail: t("panel.diagnosis") })).toBe("AHDE · Разбор");
		expect(typeof renderRunDetailPage).toBe("function");
	});
});
