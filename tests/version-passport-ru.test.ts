import { afterEach, describe, expect, it } from "vitest";
import {
	renderVersionPassportMarkdown,
	type ShippedVersionPassport,
	type VersionPassport,
} from "../src/application/version-passport.js";
import { renderAgentLogChart } from "../src/builder/render/agent-log.js";
import { plainPaint } from "../src/builder/render/paint.js";
import type { AgentLog } from "../src/application/agent-log.js";
import { setLanguage } from "../src/i18n.js";

/**
 * The passport in the operator's language, over projections written by hand.
 *
 * The page is the one artifact that leaves this machine: the operator sends the
 * markdown file to whoever paid for the agent. Live session 8 shipped that
 * reader an all-English page out of an all-Russian session, so what is checked
 * here is the page as a document — every host sentence bent, the units the
 * dictionary's, the hashes below the fold, and the words the operator typed
 * quoted exactly as they were typed.
 *
 * Written from literals rather than from a cycle fixture on purpose: a fixture
 * carries an English Spec, and a Spec is the client's own words, which this
 * page must never translate. Here the operator's words are Russian, so anything
 * Latin left on the page is either an identifier or a leak.
 */

/**
 * Latin runs that may survive a Russian render: ids, hashes, shas, model and
 * command names, the product's own names. Anything else is an English word that
 * leaked onto the page. Copied from `tests/i18n.test.ts`, plus the names this
 * page is allowed to print.
 */
const ALLOWED_LATIN = new Set([
	"AHDE", "ahde", "Builder", "Pi", "label", "calibrate", "corpus", "sha", "erun", "spec", "cand",
	"mock", "model", "n", "v", "CI", "improved", "pass", "vs", "A",
]);

function leakedEnglish(text: string): string[] {
	const stripped = text
		// Two identity shapes this page prints whole: the actor id an apply or a
		// promotion recorded, and the content-hash id of a failure mode. Stripped
		// before the hash rule below, which would otherwise eat their hex tail and
		// leave the prefix looking like an English word.
		.replace(/\blocal:[\w-]+/g, " ")
		.replace(/\bfailure-mode-[\w-]*…?/g, " ")
		// ids, hashes, shas, paths, urls and dotted/dashed technical tokens
		.replace(/\b[0-9a-f]{7,}\b/g, " ")
		.replace(/[\w.-]*\/[\w./-]*/g, " ")
		.replace(/\b[A-Za-z][\w-]*[0-9][\w-]*/g, " ")
		.replace(/\b[A-Z][A-Z0-9_]{2,}\b/g, " ");
	const words = stripped.match(/[A-Za-z]{2,}/g) ?? [];
	return [...new Set(words.filter((word) => !ALLOWED_LATIN.has(word)))];
}

const CORPUS_ID = `corpus-${"4c8cf35a19c6".repeat(5)}abcd`;
const CORPUS_HASH = `sha256:${"b4dc49c7c7db".repeat(5)}abcd`;
const PROPOSAL_HASH = `sha256:${"a1196f65b2c4".repeat(5)}abcd`;
const SPEC_ID = `spec-${"6fb44dec07d3".repeat(5)}abcd`;

/** The ship reason as the Builder wrote it: English, and quoted, not translated. */
const SHIP_REASON = "Ship the reviewed returns-policy candidate.";

function shipped(overrides: Partial<ShippedVersionPassport> = {}): ShippedVersionPassport {
	return {
		schemaVersion: 1,
		agent: "agent-1",
		version: "v0.2.0",
		at: "2026-09-01T10:00:00.000Z",
		baselineSha: "a".repeat(40),
		candidateSha: "b".repeat(40),
		model: { provider: "mock", id: "model-1" },
		promised: {
			title: "Агент поддержки по возвратам",
			purpose: "Отвечать покупателям про сроки и порядок возврата.",
			successCriteria: ["Ответ содержит применимое правило"],
			constraints: ["Не выдумывать правила"],
		},
		measured: {
			development: {
				verdict: "improved",
				tasks: 18,
				repetitions: 3,
				excludedTasks: 1,
				baselinePassRate: 0.222,
				candidatePassRate: 0.611,
				baselineScore: 0.491,
				candidateScore: 0.852,
				scoreDelta: 0.361,
				confidence95: { low: 0.12, high: 0.58 },
			},
			sealed: { verdict: "pass", tasks: 20, repetitions: 3, outcome: "improved" },
			resources: { costRatio: 1.4, latencyRatio: 0.9, tokenRatio: 1.125, judgeCostUsd: 0.42 },
			predicted: {
				kind: "score",
				predictedPp: 65,
				actualPp: 38.9,
				confidence95Pp: { low: 12, high: 58 },
				verdict: "miss",
				errorPp: 26.1,
			},
		},
		judge: { agreement: 0.84, kappa: 0.62, subjects: 12, checks: 30, majorityClassBaseline: 0.6 },
		limits: {
			unresolvedModes: ["Ответ не выдержал форму, которую требует проверка"],
			unresolvedOmitted: 2,
			noise: {
				verdict: "inconclusive",
				confidence95: { low: -0.08, high: 0.08 },
				flipRate: 0.03,
				tasks: 18,
				repetitions: 3,
				at: "2026-08-31T10:00:00.000Z",
			},
			developmentCorpus: { id: CORPUS_ID, hash: CORPUS_HASH },
			sealedTasks: 20,
			sealedOrigin: "judge-generated-kb",
		},
		provenance: {
			candidateId: "cand-1",
			experimentId: "experiment-1",
			approvedSpecId: SPEC_ID,
			proposalRunId: "builder-run-1",
			proposalSha256: PROPOSAL_HASH,
			appliedBy: "local:operator",
			appliedVia: null,
			reviewedBy: "local:operator",
			promotedBy: "local:operator",
			reason: SHIP_REASON,
			developmentEvalRuns: { baseline: "erun-1", candidate: "erun-2" },
			predictionCalibration: {
				scored: 5,
				hits: 4,
				meanAbsoluteErrorPp: 9.2,
				strip: ["hit", "hit", "miss", "hit", "hit"],
				unpredicted: 1,
			},
		},
		warnings: [],
		...overrides,
	};
}

function target(overrides: Partial<VersionPassport> = {}): VersionPassport {
	return {
		schemaVersion: 1,
		agentId: "agent-1",
		projectId: "project-1",
		candidateId: "cand-1",
		promoted: true,
		versionTag: "v0.2.0",
		at: "2026-09-01T10:00:00.000Z",
		revisions: { baselineSha: "a".repeat(40), candidateSha: "b".repeat(40) },
		model: { provider: "mock", id: "model-1" },
		promised: {
			specId: SPEC_ID,
			title: "Агент поддержки по возвратам",
			successCriteria: ["Ответ содержит применимое правило"],
			constraints: ["Не выдумывать правила"],
		},
		measured: {
			development: {
				verdict: "improved",
				baselinePassRate: 0.222,
				candidatePassRate: 0.611,
				baselineScore: 0.491,
				candidateScore: 0.852,
				scoreDelta: 0.361,
				confidence95: { low: 0.12, high: 0.58 },
				design: { tasks: 18, repetitions: 3 },
			},
			sealed: { verdict: "pass", design: { tasks: 20, repetitions: 3 }, outcome: "improved" },
			resources: { costRatio: 1.4, latencyRatio: 0.9, tokenRatio: 1.125, judgeCostUsd: 0.42 },
		},
		judge: { graderSpecs: 1, stats: null, majorityClassBaseline: null, note: null },
		limits: {
			diagnosisBound: true,
			unresolved: [{
				failureModeId: `failure-mode-${"0123456789ab".repeat(2)}`,
				category: "output-contract",
				outcome: "persisted",
				baselineFailureRateBps: 2_600,
				candidateFailureRateBps: 300,
			}],
			unresolvedNote: null,
			noiseBand: {
				candidateId: "cand-aa",
				targetSha: "a".repeat(40),
				design: { tasks: 18, repetitions: 3 },
				confidence95: { low: -0.08, high: 0.08 },
				verdict: "inconclusive",
			},
			dataset: {
				development: { corpusId: CORPUS_ID, name: "Возвраты — разработка", cases: 18 },
				sealed: { cases: 20, origin: "judge-generated-kb" },
			},
		},
		provenance: {
			specId: SPEC_ID,
			proposalHash: PROPOSAL_HASH,
			gatePolicyIds: ["development-ci-v4"],
			evalRuns: { developmentBaseline: "erun-1", developmentCandidate: "erun-2" },
			appliedBy: { actorId: "local:operator", reason: "Правка применена оператором вручную", at: "2026-09-01T09:00:00.000Z" },
		},
		...overrides,
	};
}

afterEach(() => {
	setLanguage(null);
});

describe("the passport a client reads, in Russian", () => {
	it("leaves no English sentence on the page the operator sends onward", () => {
		setLanguage("ru");
		const markdown = renderVersionPassportMarkdown(shipped());
		// The ship reason is the only English on the page, and it is a quote.
		expect(markdown).toContain(`причина, как её назвал Билдер: “${SHIP_REASON}”`);
		expect(leakedEnglish(markdown.replace(SHIP_REASON, ""))).toEqual([]);
	});

	it("says the same about the CLI page, section for section", () => {
		setLanguage("ru");
		expect(leakedEnglish(renderVersionPassportMarkdown(target()))).toEqual([]);
	});

	it("writes the units the dictionary owns, and never a hardcoded pp", () => {
		setLanguage("ru");
		const markdown = renderVersionPassportMarkdown(shipped());
		expect(markdown).toMatch(/п\.п\./);
		expect(markdown).not.toMatch(/\d\s?pp\b/);
		expect(markdown).not.toMatch(/\bpts\b/);
		// The promise, beside the result, in the same units.
		expect(markdown).toContain("- Обещано +65 п.п. (балл) · получено +38.9 п.п.");
		expect(markdown).toContain("Builder предсказывает: попаданий 4/5 · ошибка ±9.2 п.п.");
	});

	it("bends every counted noun and names who wrote the exam", () => {
		setLanguage("ru");
		const markdown = renderVersionPassportMarkdown(shipped());
		expect(markdown).toContain("- Схема: 18 кейсов × 3 повтора · 1 исключено");
		expect(markdown).toContain("экзамен 20 кейсов, написан судьёй по базе знаний, закрыт без проверки");
		expect(markdown).toContain("согласие 84% · κ 0.62 · 12 размеченных кейсов, 30 проверок");
	});

	it("keeps every hash below the fold and the short form on the face", () => {
		setLanguage("ru");
		const [face, footer] = renderVersionPassportMarkdown(shipped()).split("## Происхождение");
		for (const identifier of [CORPUS_ID, CORPUS_HASH, PROPOSAL_HASH, SPEC_ID]) {
			expect(face).not.toContain(identifier);
			expect(footer).toContain(identifier);
		}
		expect(face).toContain("corpus-4c8cf35a19c6…");
	});

	it("still renders the page in English when that is the language", () => {
		setLanguage("en");
		const markdown = renderVersionPassportMarkdown(shipped());
		for (const heading of ["## Promised", "## Measured", "## Judge", "## Known limits", "## Provenance", "## Identifiers"]) {
			expect(markdown).toContain(heading);
		}
		expect(markdown).toContain("- Design: 18 cases × 3 repetitions · 1 excluded");
		expect(markdown).toContain("- Promised +65 pts (score) · got +38.9 pts");
		expect(markdown).toContain(`reason, in the Builder's own words: “${SHIP_REASON}”`);
	});
});

/**
 * Live session 8 read `балл 85.0% → 85.0% за 1 версия` under the growth chart:
 * an arrow between a number and itself, and a noun in the wrong case. A first
 * version has nothing behind it, and the line has to say so.
 */
describe("the growth chart on a first version", () => {
	function log(scores: readonly number[]): AgentLog {
		return {
			targetId: "agent-1",
			projectId: "project-1",
			rows: [],
			omitted: 0,
			unreadable: 0,
			versions: scores.map((score, index) => ({
				candidateId: `cand-${index + 1}`,
				tag: `v0.${index + 1}.0`,
				at: `2026-09-0${index + 1}T10:00:00.000Z`,
				score,
			})),
			cumulativeCostUsd: 1.5,
			calibration: { scored: 0, hits: 0, meanAbsoluteErrorPp: null, strip: [], unpredicted: 0 },
		};
	}

	it("says it is the first version instead of drawing an arrow to itself", () => {
		setLanguage("ru");
		const chart = renderAgentLogChart(log([0.85]), plainPaint).join("\n");
		expect(chart).toContain("первая версия · балл 85.0%");
		expect(chart).not.toContain("→");
		expect(chart).not.toContain("за 1 версия");
	});

	it("bends the noun once there is more than one version", () => {
		setLanguage("ru");
		expect(renderAgentLogChart(log([0.5, 0.85]), plainPaint).join("\n"))
			.toContain("50.0% → 85.0% за 2 версии");
		expect(renderAgentLogChart(log([0.5, 0.6, 0.7, 0.8, 0.85]), plainPaint).join("\n"))
			.toContain("50.0% → 85.0% за 5 версий");
	});
});
