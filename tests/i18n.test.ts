import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { language, messageKeys, plural, resolveLanguage, setLanguage, settingsPath, t, verdictLabel } from "../src/i18n.js";
import { renderConfirmation } from "../src/builder/render/confirmation.js";
import { renderDecision } from "../src/builder/render/decision.js";
import { blockerLines, renderDatasetCases, renderHeader, renderCandidate, renderReview } from "../src/builder/render/view.js";
import { datasetCasePreview } from "../src/workbench/workbench.js";
import { CorpusTaskSchema } from "../src/corpus.js";
import { renderCalibration } from "../src/builder/render/calibration.js";
import { plainPaint } from "../src/builder/render/paint.js";
import { stageLabel, nextStep } from "../src/builder/render/stage.js";
import { renderRunDetailPage } from "../src/evidence/pages.js";
import { createRunProgressPresenter } from "../src/builder/run-progress.js";
import { renderBuilderHelp } from "../src/builder/commands.js";
import {
	explainRun,
	failureModeReading,
	runErrorReading,
	type GraderFinding,
	type RunExplanation,
	type RunTraceFacts,
} from "../src/application/run-explanation.js";
import { humanizeCommandError } from "../src/builder/commands.js";
import { WorkbenchTypedRefusalError } from "../src/workbench/errors.js";
import { ProposalIneligibleError } from "../src/application/improvement-brief.js";
import { SEALED_GATE_POLICY } from "../src/domain/comparison-gate.js";
import { receiptLines } from "../src/builder/render/trace.js";
import { turnBudgetLine } from "../src/workbench/workbench.js";
import { assertWorkbenchDecisionStage } from "../src/workbench/transition-policy.js";
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
				outcome: "improved",
				outcomeLine: "pass · лучше",
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
	// The argument of `/help all`: a word the operator types, not one they read.
	"all",
]);

/**
 * The only Latin a Russian DICTIONARY FORM may carry, one reason each. Nothing
 * here is a word: they are the two product names, the CLI and the things an
 * operator types or reads off a file — command and flag names, id prefixes,
 * field names, formats, a key on the keyboard, and the two verdict tokens the
 * sentences quote. A word that is not one of these is an English leak, and the
 * fix is a Russian form, never a new entry here.
 */
const MACHINE_LATIN = new Set([
	// The products and the binary.
	"AHDE", "ahde", "Builder", "Pi", "Target", "Git", "OAuth",
	// Commands, subcommands, flags and argument values the operator types.
	"target", "regrade", "next", "prev", "all", "trace", "traces", "run", "discard",
	// Ids, prefixes and field names read off records and screens.
	"id", "Id", "erun", "judge", "ME", "md", "manifest", "yaml", "semver", "Enter",
	// Verdict tokens quoted inside a sentence; scripts match on them.
	"underpowered",
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

	it("draws a worlded case as four Russian lines, and names its failure mode in Russian", () => {
		setLanguage("ru");
		const lines = renderDatasetCases([datasetCasePreview(CorpusTaskSchema.parse({
			id: "task_001",
			input: "Заблокируйте договор 42.",
			world: {
				state: { client: { name: "Иван Петров" }, accounts: { "42": { status: "ok" } } },
				expect: [{ path: "accounts.42.status", op: "equals", value: "frozen" }],
			},
			graders: [{ type: "tool_called", tool: "check_account" }],
		}))], plainPaint);
		expect(lines).toEqual([
			"   1. «Заблокируйте договор 42»",
			"      кто: Иван Петров",
			"      что есть: accounts.42.status=ok · client.name=Иван Петров",
			"      что хочет: Заблокируйте договор 42.",
			'      что должно: accounts.42.status equals "frozen" · tool check_account',
		]);
		expect(t("mode.title.world-state")).toBe("Мир не пришёл в нужное состояние");
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
			"Проверка около $0.42 · около 4 минут — одобряя правку, ты одобряешь и эту проверку",
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

	/**
	 * The one question that starts testing names both models a measurement uses
	 * besides the agent — and the variable each key is read from, never a value.
	 */
	it("names the judge and the client's model in the start-testing dialog, in Russian", () => {
		setLanguage("ru");
		const parts = [
			t("confirm.start-testing.part.judge"),
			t("confirm.start-testing.part.user"),
			t("confirm.start-testing.part.publish-corpus", { cases: plural(3, "case") }),
			t("confirm.start-testing.part.run", { runs: plural(3, "execution") }),
		];
		const confirmation: WorkbenchConfirmation = {
			kind: "start-testing",
			title: t("confirm.start-testing.title", { parts: parts.join(", ") }),
			reason: "оператор сказал «тесты»",
			subject: {
				operation: "start-testing",
				steps: ["configure-evaluators", "publish-corpus", "run-eval"],
				spec: t("confirm.start-testing.already-approved", { title: "Поддержка тарифов" }),
				basket: t("confirm.start-testing.basket", { name: "Корзина разработки", cases: plural(3, "case") }),
				judge: t("confirm.start-testing.judge", { model: "openrouter/glm-5.3", env: "OPENROUTER_API_KEY" }),
				user: t("confirm.start-testing.user", { model: "openrouter/glm-5.3", env: "OPENROUTER_API_KEY" }),
				run: t("confirm.start-testing.run", { cases: 3, repetitions: 1, executions: plural(3, "execution") }),
				estimatedCost: t("estimate.nothing-comparable-alone"),
				estimatedTime: t("estimate.nothing-comparable-alone"),
			},
			subjectHash: "d".repeat(64),
			policy: "consequential",
			question: t("confirm.question", { title: t("confirm.start-testing.title", { parts: parts.join(", ") }) }),
		};
		const lines = renderConfirmation(confirmation, plainPaint);
		expect(lines).toContain("Судья openrouter/glm-5.3 (не модель агента) · ключ OPENROUTER_API_KEY");
		expect(lines).toContain("Собеседник openrouter/glm-5.3 · ключ OPENROUTER_API_KEY");
		expect(confirmation.question).toBe(
			"Начать тесты — выбрать судью, выбрать собеседника, опубликовать 3 кейса, прогнать 3 запуска?",
		);
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
		// One sentence, and the score the gate decided on leads it.
		expect(text).toContain("Разработка стало лучше · балл 40% → 70% (+23 п.п., 95% ДИ +5 … +35) на 10 кейсах × 3 · пасс-рейт 40% → 70%");
		expect(text).toContain("↑ 3 лучше · ↓ 1 хуже · = 6 без изменений · цена ×1.4 · задержка ×0.9");
		expect(text).toContain("Экзамен пройден · лучше (+20 п.п., 95% ДИ +2 … +38) на 20 кейсах × 3");
		expect(text).toContain("Судья не откалиброван · /label");
		// The tokens tests and scripts match on are untouched by the language.
		expect(verdictLabel("improved")).toBe("стало лучше");
		expect(makeCandidate().development?.gate?.verdict).toBe("improved");
		expect(makeCandidate().sealedHoldout.gate?.verdict).toBe("pass");
		expect(t("label.sealed-holdout")).toBe("Экзамен");
	});

	it("says the exam's outcome and its shortfall in Russian", () => {
		setLanguage("ru");
		expect(t("exam.outcome-improved")).toBe("лучше");
		expect(t("exam.outcome-no-regression")).toBe("ухудшения не доказано, улучшения тоже");
		// What the exam has, what the gate needs, and the difference.
		expect(t("ship-gate.underpowered", { cases: plural(12, "case"), minimum: 15, missing: 3 }))
			.toBe("в экзамене 12 кейсов; для выкатки нужно 15 — ещё 3");
		expect(t("gate.exam-shortfall", { cases: plural(14, "case"), minimum: 15, missing: 1 }))
			.toBe("в экзамене 14 кейсов; закрытому порогу нужно 15 — ещё 1");
		expect(t("gate.repetition-shortfall", { minimum: 2, ran: 1, missing: 1 }))
			.toBe("нужно повторов: 2, прогнали 1 — ещё 1");
		expect(t("exam.size-for-noise", { cases: plural(35, "case") }))
			.toBe("чтобы увидеть разницу ±10 п.п. на экзамене, нужно около 35 кейсов (по этому шуму)");
		expect(t("exam.size-hint", { cases: plural(20, "case"), needed: plural(35, "case") }))
			.toBe("экзамен 20 кейсов; при таком шуме для ±10 п.п. нужно около 35 кейсов");
		expect(t("exam.of-requested", { cases: 19, requested: 20 })).toBe("19 из 20 запрошенных");
		expect(t("exam.dropped-duplicate", { dropped: plural(1, "duplicate") }))
			.toBe("отброшено: 1 дубликат");
		expect(t("exam.dropped-malformed", { dropped: plural(2, "malformed case") }))
			.toBe("отброшено: 2 кейса с ошибкой формы");
		// Every one of them is Russian all the way through.
		for (const key of [
			"exam.outcome-improved",
			"exam.outcome-no-regression",
			"ship-gate.underpowered",
			"gate.exam-shortfall",
			"gate.repetition-shortfall",
			"exam.size-for-noise",
			"exam.size-hint",
			"exam.of-requested",
		] as const) {
			expect(leakedEnglish(t(key, { cases: "", needed: "", minimum: "", missing: "", ran: "", requested: "" })))
				.toEqual([]);
		}
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
			"Дальше Скажи «выкатывай» — или «отклонить»",
		]);
		expect(leakedEnglish(lines.join("\n"))).toEqual([]);
	});

	/**
	 * The `◆` headline after the one-time bootstrap. Session 7 read
	 * `Target identity and model configured in a one-time reviewed commit.`
	 * twice — once as the transition line, once as the headline — with the
	 * Russian «Агент настроен isp-support @ 78c763d5de» directly underneath,
	 * and `credential env` inside the Russian line below that.
	 */
	it("says what the bootstrap did, and names the key's variable, in Russian", () => {
		setLanguage("ru");
		const view = makeView({ stage: "spec-design", headline: "Опиши агента" });
		for (const key of ["message.target-created", "message.target-adopted", "message.target-configured", "message.evaluators-configured"] as const) {
			expect(leakedEnglish(t(key))).toEqual([]);
		}
		const lines = renderDecision({
			kind: "configure-target",
			message: t("message.target-configured"),
			result: {
				targetId: "isp-support",
				targetGitSha: SHA_A,
				receiptId: "configure-target-1",
				credentialEnv: "OPENROUTER_API_KEY",
			},
			view,
		}, plainPaint);
		expect(lines.join("\n")).not.toContain("credential env");
		expect(lines[1]).toContain("ключ в переменной OPENROUTER_API_KEY");
		expect(leakedEnglish(lines.join("\n").replace(/OPENROUTER_API_KEY|isp-support/g, ""))).toEqual([]);
	});

	// The typed blocker, whole and in Russian, inside the one sentence the
	// operator reads about a verification that did not run.
	it("says why the verification did not start in Russian, whole", () => {
		setLanguage("ru");
		const view = makeView({ stage: "candidate-verification", headline: "Проверка кандидата" });
		const lines = renderDecision({
			kind: "apply-proposal",
			message: "Proposal applied; automatic verification is blocked",
			result: {
				runId: "run-1",
				branch: "ahde/candidate-1",
				candidateSha: SHA_B,
				proposalHash: "d".repeat(64),
				verification: {
					outcome: "blocked",
					reason: "Candidate verification requires an evaluator-owned sealed holdout corpus. Get one first: request generate-holdout.",
					reasonCode: { code: "blocker.sealed-exam-missing" },
				},
			},
			view,
		}, plainPaint);
		// Whole, across as many lines as it needs; nothing about it is cut.
		const said = lines.slice(2, -1).join(" ").replace(/\s+/g, " ").trim();
		expect(said).toBe(
			"Проверка не запустилась: у агента нет закрытого экзамена. " +
				"Скажи «сгенерируй экзамен» — его напишет судья, или импортируй закрытый JSONL.",
		);
		const text = lines.join("\n");
		expect(text).not.toContain("sealed holdout corpus");
		// The typed refusal says it did not start; the label would say it twice.
		expect(text).not.toContain("Автоматическая проверка не запустилась Проверка");
		expect(leakedEnglish(text)).toEqual([]);
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

/**
 * Keys whose Russian form is identical to their English one on purpose: every
 * one of them is a layout template made of placeholders, separators and
 * digits, with no word in it to bend. Anything else that reads the same in both
 * languages is an untranslated string, not a format.
 */
const IDENTICAL_BY_DESIGN = new Set([
	"judge.label-hint",
	"label.ask-assertion",
	"confirm.start-testing.basket",
	"confirm.start-testing.run",
	"confirm.question",
	"result.screen-shape",
	"panel.title",
	"card.entries",
	"headline.run",
	"status.activity",
	"passport.design",
	// lane: passport-ru — two layout templates on the markdown page.
	"passport.md.design",
	"passport.md.promised-title",
	"fixtures.failed",
	"why.grader-expected",
	"why.grader-plain",
	// A grader phrasing the host does not recognize is quoted whole; the quote
	// is the record, and a record has no second language.
	"why.actual.reason",
	// A dash is a dash in both languages.
	"metrics.not-reported",
	// lane: gate-dialog — an ordinal in brackets after a label the caller wrote.
	"dialog.choice-ordinal",
]);

describe("the dictionary itself", () => {
	it("gives every key a Russian form that is not just the English one", () => {
		const leaked: string[] = [];
		for (const key of messageKeys()) {
			setLanguage("en");
			const english = t(key);
			setLanguage("ru");
			if (t(key) === english && !IDENTICAL_BY_DESIGN.has(key)) leaked.push(key);
		}
		expect(leaked).toEqual([]);
	});

	it("keeps the allowlist honest: every entry is a template with no word in it", () => {
		for (const key of IDENTICAL_BY_DESIGN) {
			setLanguage("ru");
			// Placeholders, the AHDE name and slash commands out; nothing may remain
			// but separators, digits and punctuation.
			const bare = t(key as never)
				.replace(/\{\w+\}/g, "")
				.replace(/\/[a-z-]+/g, "")
				.replace(/\bAHDE\b/g, "");
			expect(bare, key).not.toMatch(/[A-Za-z]{2,}/);
		}
	});

	/**
	 * "The Russian form differs from the English one" was the whole guard, and
	 * every English literal that reached a Russian screen for three sessions
	 * running passed it: a sentence built OUTSIDE the dictionary never had a
	 * key to compare. This reads the forms themselves.
	 */
	it("leaves nothing but machine text Latin in any Russian form", () => {
		setLanguage("ru");
		const leaked = new Map<string, string[]>();
		for (const key of messageKeys()) {
			const found = leakedEnglish(t(key).replace(/\{\w+\}/g, " "))
				.filter((word) => !MACHINE_LATIN.has(word));
			if (found.length > 0) leaked.set(key, found);
		}
		expect([...leaked.entries()].map(([key, words]) => `${key}: ${words.join(" ")}`)).toEqual([]);
	});

	/**
	 * A name one form interpolates and the other does not is a name nobody
	 * passes: the screen prints `{count}` verbatim, or silently drops the
	 * number the sentence was about. Five keys were in that state.
	 */
	it("interpolates exactly the same names in both languages", () => {
		const names = (text: string): string => [...new Set(text.match(/\{\w+\}/g) ?? [])].sort().join(" ");
		const mismatched: string[] = [];
		for (const key of messageKeys()) {
			setLanguage("en");
			const english = names(t(key));
			setLanguage("ru");
			const russian = names(t(key));
			if (english !== russian) mismatched.push(`${key}: en(${english}) ru(${russian})`);
		}
		expect(mismatched).toEqual([]);
	});
});

/**
 * Session 8, the third session in a row: the one screen that explains a failed
 * check spoke English on the Russian path. The dictionary guard above could
 * not see it, because those sentences were built from literals OUTSIDE the
 * dictionary and so had no key to compare. These read the finished screen.
 */
describe("ru: what a failed check wanted", () => {
	/**
	 * Everything the host WROTE about one run, with everything it QUOTED taken
	 * out: the grader's own recorded reason — canonical English on disk, quoted
	 * verbatim on purpose, exactly as the transition policy keeps its machine
	 * line — and the machine text the sentences interpolate, which is grader
	 * names, grader type names, tool names, world paths and canonical JSON.
	 */
	function hostWritten(sentences: readonly string[], quoted: readonly string[]): string {
		let text = sentences.join("\n");
		for (const item of quoted) text = text.split(item).join(" ");
		return text;
	}

	function finding(overrides: Partial<GraderFinding>): GraderFinding {
		return {
			name: "grader",
			type: "judge",
			checkCode: null,
			passed: false,
			score: 0,
			reason: "",
			abstained: false,
			assertions: null,
			assertionVerdicts: null,
			choice: null,
			jury: null,
			chip: "✗",
			...overrides,
		};
	}

	function explain(graders: GraderFinding[], facts: RunTraceFacts | null): RunExplanation {
		return explainRun({
			run: {
				runId: "run-9",
				taskId: "task-3",
				repetitionIndex: 0,
				status: "completed",
				error: null,
				metrics: { toolCalls: 2 },
			} as never,
			graders,
			facts,
			modes: [],
			flip: null,
		});
	}

	it("says what a world check wanted, and what the conversation left instead", () => {
		setLanguage("ru");
		const explanation = explain([finding({
			name: "task-3#0:world_state:accounts.42.status",
			type: "world_state",
			checkCode: "world-state",
			reason: 'world at accounts.42.status is "open", expected "frozen"',
		})], null);
		expect(explanation.sentences[1]).toBe(
			"task-3#0:world_state:accounts.42.status (world_state) "
			+ 'ожидалось: мир по пути accounts.42.status равен "frozen"; там "open".',
		);
		expect(leakedEnglish(hostWritten(explanation.sentences, [
			'world at accounts.42.status is "open", expected "frozen"',
			"task-3#0:world_state:accounts.42.status",
			"world_state",
			"accounts.42.status",
			'"frozen"',
			'"open"',
		]))).toEqual([]);
	});

	it("says which tool the case wanted called, and what the agent called instead", () => {
		setLanguage("ru");
		const explanation = explain([finding({
			name: "task-3#0:tool_called:check_dbo",
			type: "tool_called",
			checkCode: "required-tool",
			reason: 'never called check_dbo with args containing "1003"',
		})], { input: null, answer: null, toolNames: ["read_file"], toolCalls: 2 });
		expect(explanation.sentences[1]).toBe(
			"task-3#0:tool_called:check_dbo (tool_called) "
			+ "ожидался вызов check_dbo с аргументами, содержащими «1003»; "
			+ "агент сделал 2 вызова инструмента — read_file.",
		);
		expect(leakedEnglish(hostWritten(explanation.sentences, [
			'never called check_dbo with args containing "1003"',
			"task-3#0:tool_called:check_dbo",
			"tool_called",
			"check_dbo",
			"read_file",
		]))).toEqual([]);
	});

	it("says what the judge's rubric wanted, and answers its assertions in Russian", () => {
		setLanguage("ru");
		const explanation = explain([finding({
			name: "task-3#0:judge",
			type: "judge",
			checkCode: "semantic-rubric",
			reason: "assertion 2 failed (2/4 yes): не назван срок",
			assertions: { total: 4, passed: 2, failed: [2, 4] },
			assertionVerdicts: [
				{ index: 1, answer: "yes", evidence: "срок указан" },
				{ index: 2, answer: "no", evidence: "не назван срок" },
				{ index: 4, answer: "unknown", evidence: "ответа недостаточно" },
			],
			jury: [
				{ juror: 1, passed: false, choice: null, answers: null },
				{ juror: 2, passed: true, choice: null, answers: null },
			],
		})], null);
		expect(explanation.sentences[1]).toBe(
			"task-3#0:judge (judge) ожидалось: выполнены все утверждения рубрики, все 4; "
			+ "судья ответил «да» на 2 из 4; не выполнены утверждения 2, 4.",
		);
		// The judge's three protocol answers are read here, never matched on.
		expect(explanation.sentences).toContain(
			"На утверждение 2 ответ «нет»; обоснование судьи: «не назван срок».",
		);
		expect(explanation.sentences).toContain(
			"На утверждение 4 ответ «не знаю»; обоснование судьи: «ответа недостаточно».",
		);
		expect(leakedEnglish(hostWritten(explanation.sentences, [
			"assertion 2 failed (2/4 yes): не назван срок",
			"task-3#0:judge",
			"judge",
		]))).toEqual([]);
	});
});

/**
 * Session 8, defect 5: the Builder met `failure mode … is not eligible for a
 * harness proposal` on the transcript, could not parse it, and asked the
 * operator to "открыть пункт в панели".
 */
describe("ru: a refusal a person has to act on", () => {
	it("reaches the operator in Russian, whole, through the one place errors are humanized", () => {
		setLanguage("ru");
		const refusals = [
			new WorkbenchTypedRefusalError("The selected sealed holdout has 4 tasks", {
				code: "refusal.sealed-exam-too-small",
				params: { tasks: plural(4, "case"), minimum: SEALED_GATE_POLICY.minTasks },
			}),
			new WorkbenchTypedRefusalError("Candidate verification needs at least 3 repetitions", {
				code: "refusal.repetitions-too-few",
				params: { minimum: SEALED_GATE_POLICY.minRepetitions },
			}),
			new WorkbenchTypedRefusalError("candidate verification failed during the sealed exam", {
				code: "refusal.check-failed-in-exam",
			}),
			new ProposalIneligibleError("improvement evidence is not eligible for a harness proposal", {
				code: "refusal.brief-not-proposable",
			}),
			new ProposalIneligibleError("failure mode fm-4c1d9e is not eligible for a harness proposal", {
				code: "refusal.mode-not-proposable",
				detail: "fm-4c1d9e",
			}),
		];
		for (const error of refusals) {
			const human = humanizeCommandError(error);
			expect(human.tone, error.reason.code).toBe("warning");
			expect(leakedEnglish(human.message), error.reason.code).toEqual([]);
			// The English sentence underneath is untouched: the model still reads it.
			expect(human.message).not.toBe(error.message);
		}
	});

	it("keeps the evaluator's own stem beside the sentence rather than inside it", () => {
		setLanguage("ru");
		const stopped = new WorkbenchTypedRefusalError("the check stopped before the exam", {
			code: "refusal.check-stopped-before-exam",
			detail: "target exited with 3",
		});
		const human = humanizeCommandError(stopped);
		expect(human.message).toBe(`${t("refusal.check-stopped-before-exam")} target exited with 3`);
		expect(leakedEnglish(t("refusal.check-stopped-before-exam"))).toEqual([]);
	});

	it("says the abandoned attempt in Russian", () => {
		setLanguage("ru");
		expect(leakedEnglish(t("message.candidate-abandoned"))).toEqual([]);
		expect(t("message.candidate-abandoned")).toContain("Прерванная попытка");
	});
});

describe("ru: the /help screen", () => {
	it("says the nine in Russian, and the whole table in Russian too", () => {
		setLanguage("ru");
		const core = renderBuilderHelp();
		const all = renderBuilderHelp(true);
		// The Latin that survives is what the operator types: the command names
		// themselves, the word `all`, `AHDE`, `Pi`, and the two credential words.
		expect(leakedEnglish(core.join("\n"))).toEqual([]);
		expect(leakedEnglish(all.join("\n"))).toEqual([]);
		// Nine lines, one sentence each, and the last one is the way to the rest.
		expect(core.filter((line) => line.startsWith("  /"))).toHaveLength(9);
		expect(core.at(-1)).not.toBe("");
		expect(core.some((line) => line.startsWith("  /help all  "))).toBe(true);
		expect(core.join("\n")).toContain("почини вторую проблему");
		// The eight AHDE asks itself are named as that, and nowhere else.
		expect(all.join("\n")).toContain("Решения хоста — их задаёт сам AHDE, набирать не нужно:");
		for (const line of core) expect(line).not.toContain("/approve");
	});
});

describe("ru: the recorded dataset", () => {
	it("bends the noun to the count and gives the count a denominator", () => {
		setLanguage("ru");
		// The genitive after «из»: «из 1 диалога», «из 2 диалогов», never the
		// nominative «2 диалога» the plain count would bend to.
		const line = (count: number): string =>
			t("export.done", { count, total: plural(count, "dialogue of"), path: "exports/erun_abc123.jsonl" });
		expect(line(1)).toBe("выгружено 1 из 1 диалога → exports/erun_abc123.jsonl");
		expect(line(2)).toBe("выгружено 2 из 2 диалогов → exports/erun_abc123.jsonl");
		expect(line(24)).toBe("выгружено 24 из 24 диалогов → exports/erun_abc123.jsonl");
		expect(line(25)).toBe("выгружено 25 из 25 диалогов → exports/erun_abc123.jsonl");
		expect(line(11)).toBe("выгружено 11 из 11 диалогов → exports/erun_abc123.jsonl");
		// Only the path is Latin, and it is a path.
		expect(leakedEnglish(line(24))).toEqual([]);
		for (const key of ["export.none", "cmd.dataset", "panel.export"] as const) {
			expect(leakedEnglish(t(key))).toEqual([]);
		}
		// The refusal names a flag, and a flag is a Latin token on purpose.
		expect(t("cmd.err.dataset-arg")).toBe("/dataset принимает --all или ничего — тогда это последний прогон");
	});
});

describe("ru refusals and notices", () => {
	it("words an illegal transition as a next step, and keeps the machine line for the model", () => {
		setLanguage("ru");
		let message = "";
		try {
			assertWorkbenchDecisionStage("apply-proposal", "spec-review");
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		const [human, machine] = message.split("\n");
		expect(human).toBe("Сейчас это не следующий шаг — Проверка описания. Скажи «ок» или что поправить");
		// The model, scripts and tests still get the exact English rule underneath.
		expect(machine).toContain("apply-proposal is not legal during spec-review");
		expect(leakedEnglish(human ?? "")).toEqual([]);
	});

	it("says what is blocking in Russian, from the typed reason rather than the English sentence", () => {
		setLanguage("ru");
		expect(blockerLines({
			blockers: ["Target harness is missing."],
			blockerReasons: [{ code: "blocker.target-missing" }],
		})).toEqual(["Агент ещё не создан."]);
		expect(blockerLines({
			blockers: ["3 active candidates are compatible with this project."],
			blockerReasons: [{ code: "blocker.candidates-ambiguous", params: { candidates: "3 кандидата" } }],
		})).toEqual(["Этому проекту подходят 3 кандидата — выбери одного."]);
		// A template still carrying REPLACE-ME names the fields it kept, and the
		// field names are manifest keys: they stay Latin on purpose.
		expect(blockerLines({
			blockers: ["Target still contains the template's REPLACE-ME stand-ins in id, model.id."],
			blockerReasons: [{ code: "blocker.target-stand-ins", params: { fields: "id, model.id" } }],
		})).toEqual([
			"У агента ещё стоят подставные REPLACE-ME из шаблона в полях id, model.id — выбери имя и модель.",
		]);
		// A view from before the reasons existed still renders its own sentence.
		expect(blockerLines({ blockers: ["something older"] })).toEqual(["something older"]);
	});

	it("says what is wrong with the judge in Russian, with the model, the variable and the count", () => {
		setLanguage("ru");
		expect(blockerLines({
			blockers: ["The development cases are graded by a judge and this Target has none configured."],
			blockerReasons: [{ code: "blocker.judge-missing" }],
		})).toEqual(["Кейсы судит судья, а он не выбран: нужен судья не на модели агента."]);
		// Model ids and environment-variable names are machine text: they stay
		// exactly as they are inside a Russian sentence.
		expect(blockerLines({
			blockers: ["The judge is the Target's own model."],
			blockerReasons: [{ code: "blocker.judge-not-independent", params: { model: "qwen-internal/qwen3.5-27b" } }],
		})).toEqual([
			"Судья — qwen-internal/qwen3.5-27b, то есть сама модель агента. " +
			"Модель, проверяющая свою же копию, — это не второе мнение.",
		]);
		expect(blockerLines({
			blockers: ["The judge credential variable is not exported."],
			blockerReasons: [{ code: "blocker.judge-credential-missing", params: { env: "OPENROUTER_API_KEY" } }],
		})).toEqual(["Ключ судьи не экспортирован: переменной OPENROUTER_API_KEY здесь нет."]);
		expect(blockerLines({
			blockers: ["The judge returned an unreadable verdict."],
			blockerReasons: [{ code: "blocker.judge-unreadable", params: { count: 3, total: 10 } }],
		})).toEqual([
			"Судья вернул нечитаемый вердикт в 3 прогонах из 10 — " +
			"последнее измерение говорит о тракте оценки, а не об агенте.",
		]);
	});

	it("says the stand-in readiness line in Russian, with the count bent and the file names left alone", () => {
		setLanguage("ru");
		expect(t("readiness.stand-ins", { files: plural(1, "file"), names: "AGENTS.md" }))
			.toBe("1 файл ещё с подставными REPLACE-ME из шаблона: AGENTS.md — опиши агента, и Билдер их заменит");
		expect(t("readiness.stand-ins", { files: plural(5, "file"), names: "AGENTS.md" }).startsWith("5 файлов ещё")).toBe(true);
		// The blocker is what stops the cycle; this line never does, and both name
		// the same thing at the same stage.
		expect(nextStep(makeView({
			stage: "target-setup",
			blockers: ["Target still contains the template's REPLACE-ME stand-ins in id."],
		}))).toBe(t("next.model-required"));
	});

	it("hides the evidence counts until there is any evidence, and the judge until it has judged", () => {
		setLanguage("ru");
		const empty = makeView({
			stage: "target-setup",
			counts: {
				specDrafts: 0, approvedSpecs: 0, corpusDrafts: 0, developmentCorpora: 0,
				sealedCorpora: 0, developmentEvals: 0, openProposals: 0, candidates: 0, calibrations: 0,
			},
		});
		const lines = renderHeader({ view: empty, builderModel: { label: null, credentialPresent: false } }, plainPaint)
			.join("\n");
		expect(lines).not.toContain("0 прогонов");
		expect(lines).not.toContain("Судья");
		expect(leakedEnglish(lines)).toEqual([]);
	});
});

describe("ru: the knowledge base", () => {
	it("names the citation failure mode and the knowledge-base exam in Russian", () => {
		setLanguage("ru");
		// The new grader's failure mode is a title an operator reads, not a code.
		expect(t("mode.title.cites-source")).toBe("Ответ не опирается на источник");
		expect(leakedEnglish(t("mode.title.cites-source"))).toEqual([]);

		// The passport's one word about where an exam's questions came from.
		expect(t("passport.exam-generated-kb")).toContain("по базе знаний");
		expect(t("passport.exam-generated-kb-reviewed")).toContain("по базе знаний");
		expect(leakedEnglish(t("passport.exam-generated-kb"))).toEqual([]);

		// The dialog, the result line, and the sentence the Builder is told.
		expect(t("generate-holdout.source-kb", { chunks: plural(16, "passage") }))
			.toBe("база знаний — 16 фрагментов, по ним судья и пишет вопросы");
		expect(plural(1, "passage")).toBe("1 фрагмент");
		expect(plural(3, "passage")).toBe("3 фрагмента");
		expect(plural(11, "passage")).toBe("11 фрагментов");
		expect(plural(1, "question")).toBe("1 вопрос");
		expect(plural(3, "question")).toBe("3 вопроса");
		expect(plural(15, "question")).toBe("15 вопросов");
		// lane: exam-kb — a base too small for an exam is refused in one Russian
		// sentence, with the number it can give and the alternative.
		expect(t("sealed-synth.kb-too-small", {
			chunks: plural(3, "passage"),
			max: plural(9, "question"),
			min: plural(15, "case"),
			count: plural(20, "case"),
		})).toBe(
			"В базе 3 фрагмента — из неё выходит не больше 9 вопросов, экзамену нужно 15 кейсов. " +
				"Могу написать экзамен из описания (20 кейсов) — делаем?",
		);
		expect(leakedEnglish(t("sealed-synth.kb-too-small", {
			chunks: plural(3, "passage"),
			max: plural(9, "question"),
			min: plural(15, "case"),
			count: plural(20, "case"),
		}))).toEqual([]);
		expect(t("ship-gate.kb-ceiling", { max: plural(18, "question") }))
			.toBe("база знаний даёт не больше 18 вопросов");
		expect(t("generate-holdout.by-judge-kb", { cases: plural(16, "case"), generator: "x/y" }))
			.toBe("16 кейсов по базе знаний · генерирует судья x/y");
		expect(t("message.exam-sealed-kb", { cases: plural(16, "case") })).toContain("по базе знаний");
		expect(t("holdout.reason-kb")).toContain("по базе знаний");
		expect(t("cmd.holdout")).toContain("из базы знаний");
	});
});

/**
 * Session 7: the host read a hung network call off the shape of a trace and
 * announced `вызвал get_account · без ответа` on the same screen as
 * `get_account · 930ms · ок`. In Russian, the run says what its record says.
 */
describe("ru: what ended a run", () => {
	it("names the typed cause of every stem this host writes", () => {
		setLanguage("ru");
		expect(runErrorReading("run timed out after 300000ms")).toEqual({
			code: "timeout",
			sentence: "агент не ответил за 300 с — таймаут модели",
			detail: "run timed out after 300000ms",
		});
		expect(runErrorReading("command Target exited with 3: agent gave up")?.sentence)
			.toBe("процесс агента завершился, не ответив");
		expect(runErrorReading("command Target did not start within 5000ms")?.sentence)
			.toBe("агент так и не запустился");
		// The sentence is Russian; the raw stem beside it stays exactly as recorded.
		expect(leakedEnglish(runErrorReading("run timed out after 300000ms")!.sentence)).toEqual([]);
	});

	it("reads one infrastructure mode as one cause counted in runs", () => {
		setLanguage("ru");
		const reading = failureModeReading({
			signature: { kind: "infrastructure-error", checkCode: null, subject: "timeout", discriminatorHash: `sha256:${"a".repeat(64)}` },
			scope: "systemic",
			observations: [],
			observedRuns: 0,
			impact: {
				affectedTasks: 7,
				totalTasks: 8,
				taskCoverageBps: 8750,
				failedOccurrences: 21,
				passedOccurrences: 3,
				reproductionBps: 8750,
			},
		});
		expect(reading.title).toBe("инфраструктура: таймаут модели");
		expect(reading.facts).toBe(
			"здесь оборвалось 21 из 24 запусков, причина — таймаут модели; "
			+ "это свидетельство о тракте оценки, а не о поведении агента",
		);
		expect(leakedEnglish(`${reading.title} ${reading.facts}`)).toEqual([]);
	});

	it("says what the run receipt actually holds, one fact per clause", () => {
		setLanguage("ru");
		const lines = receiptLines({
			worldKeys: 3,
			judge: null,
			simulatedUser: null,
			tokens: null,
			costUsd: null,
			incomplete: true,
		}, plainPaint);
		expect(lines).toEqual([
			"Квитанция мир: есть (3 ключа) · судья: не запускался — прогон упал · "
			+ "собеседник: не запускался — прогон упал · токены: не сообщены",
		]);
		expect(leakedEnglish(lines.join("\n"))).toEqual([]);
		const spent = receiptLines({
			worldKeys: null,
			judge: { calls: 2, costUsd: 0 },
			simulatedUser: { calls: 5, costUsd: 0.01 },
			tokens: 640,
			costUsd: 0.0015,
			incomplete: false,
		}, plainPaint);
		expect(spent).toEqual(["Квитанция мир: нет · судья: 2 вызова, $0.00 · собеседник: 5 вызовов, $0.01 · токены: 640, $0.00"]);
	});

	it("says the run budget is per turn, in Russian", () => {
		setLanguage("ru");
		expect(turnBudgetLine(300_000, [{ simulatedUser: { maxTurns: 6 } }])).toBe("таймаут 300 с на ход · до 6 ходов");
		expect(turnBudgetLine(300_000, [{}])).toBe("таймаут 300 с на ход");
		expect(plural(1, "agent turn")).toBe("1 ход");
		expect(plural(3, "agent turn")).toBe("3 хода");
		expect(plural(11, "agent turn")).toBe("11 ходов");
		expect(leakedEnglish(turnBudgetLine(300_000, [{ simulatedUser: { maxTurns: 6 } }]))).toEqual([]);
	});
});

describe("ru: a dirty agent folder", () => {
	it("is refused in the operator's language, naming the files", async () => {
		const { TargetAuthoringContextError } = await import("../src/application/target-authoring-context.js");
		setLanguage("ru");
		const error = new TargetAuthoringContextError(
			"TARGET_CONTEXT_DIRTY",
			"Target has uncommitted changes: notes.md. Commit them, then author.",
			undefined,
			{ code: "target.dirty", params: { paths: "notes.md" } },
		);
		const human = humanizeCommandError(error);
		expect(human.message).toBe("В папке агента есть незакоммиченные изменения: notes.md. Закоммить их — и продолжим.");
		// The file name is the operator's, not the host's: it is not a leak.
		expect(leakedEnglish(human.message.replace("notes.md", ""))).toEqual([]);
	});
});
