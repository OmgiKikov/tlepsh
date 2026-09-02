import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { candidateRecordPath } from "../src/application/candidate-review.js";
import {
	VersionPassportError,
	compileVersionPassport,
	renderVersionPassportMarkdown,
	type VersionPassport,
} from "../src/application/version-passport.js";
import { createCorpus } from "../src/corpus.js";
import { parseCliInvocation } from "../src/cli-invocation.js";
import { cliHelp } from "../src/cli-help.js";
import {
	CandidateRecordSchema,
	createCandidate,
	transitionCandidate,
	type CandidateRecord,
	type ComparisonGateEvidenceV4,
} from "../src/domain/candidate.js";
import { saveSpecSnapshot } from "../src/spec.js";
import { writeJsonArtifact } from "../src/storage/artifacts.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

/**
 * The version passport, over synthetic but schema-exact evidence.
 *
 * The passport is a read: it may only say what a durable artifact already says,
 * and it may never say anything about the sealed exam beyond its verdict and
 * its size. So the fixture publishes a real sealed corpus with a loud name and
 * the tests assert that neither the name nor the id reaches the page — the
 * projection behind it included, because `--json` prints exactly that.
 */

const PROJECT_ID = "test-target";
const BASE_SHA = "a".repeat(40);
const CANDIDATE_SHA = "b".repeat(40);
const HASH = `sha256:${"c".repeat(64)}`;
const PROPOSAL_HASH = `sha256:${"d".repeat(64)}`;

/** Loud on purpose: if it ever appears in a passport, the boundary is broken. */
const SEALED_CORPUS_NAME = "SEALED-EXAM-DO-NOT-PRINT";

const APPLY_REASON = "Autoloop cycle 2: apply the proposal for failure-mode-0123456789abcdef01234567.";

interface Fixture {
	dir: string;
	runsRoot: string;
	stateRoot: string;
	specId: string;
	developmentCorpus: { id: string; hash: string };
	sealedCorpus: { id: string; hash: string };
}

let fixture: Fixture;

const human = (id = "local-user") => ({ kind: "human" as const, id });
const system = { kind: "system" as const, id: "candidate-experiment" };

function corpusTasks(prefix: string, count: number): unknown[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `${prefix}-${index + 1}`,
		input: `Сколько дней на возврат? (${index + 1})`,
		graders: [{ type: "output_contains", text: "30 дней" }],
	}));
}

function comparison(options: {
	sealed: boolean;
	tasks: number;
	repetitions: number;
	verdict: ComparisonGateEvidenceV4["verdict"];
	passRates?: { baseline: number; candidate: number };
}): ComparisonGateEvidenceV4 {
	const baselinePassRate = options.passRates?.baseline ?? 0;
	const candidatePassRate = options.passRates?.candidate ?? 1;
	return {
		schemaVersion: 4,
		algorithmId: "exact-comparison-gate-v4",
		policyId: options.sealed ? "sealed-guardrail-v4" : "development-ci-v4",
		surface: options.sealed ? "sealed" : "development",
		comparisonHash: HASH,
		evidenceHash: HASH,
		gateHash: HASH,
		summary: {
			taskCount: options.tasks,
			baselinePassRate,
			candidatePassRate,
			delta: candidatePassRate - baselinePassRate,
			baselineScore: baselinePassRate,
			candidateScore: candidatePassRate,
			scoreDelta: candidatePassRate - baselinePassRate,
			confidence95: { low: 0.42, high: 0.86 },
			improved: options.tasks,
			regressed: 0,
			unchanged: 0,
		},
		design: { tasks: options.tasks, repetitions: options.repetitions, excludedTasks: 0 },
		verdict: options.verdict,
		flags: { regressedTasks: 0, improvedTasks: options.tasks, collapsedTasks: 0 },
		resources: {
			baseline: { runs: 12, costUsd: 0.4, meanLatencyMs: 2_000, meanTokens: 800 },
			candidate: { runs: 12, costUsd: 0.5, meanLatencyMs: 1_740, meanTokens: 880 },
			costRatio: 1.25,
			latencyRatio: 0.87,
			tokenRatio: 1.1,
		},
		reasons: ["fixture verdict"],
	};
}

/**
 * A promoted applied-Builder candidate, built through the same transitions the
 * engine uses, so every cross-field invariant the record schema enforces is
 * exercised by the fixture rather than worked around.
 */
function promotedRecord(options: { diagnosisBound: boolean; promote?: boolean }): CandidateRecord {
	const source = options.diagnosisBound
		? {
			evalRunId: "erun-source",
			evalRun: { path: "/evidence/eval_run.json", sha256: HASH },
			diagnosisId: "diagnosis-fixture",
			diagnosis: { path: "/evidence/diagnosis.json", sha256: HASH },
			dataset: `development-corpus-${fixture.developmentCorpus.id}`,
			datasetHash: fixture.developmentCorpus.hash,
			suiteHash: HASH,
			developmentCorpus: fixture.developmentCorpus,
		}
		: null;
	const candidateId = options.promote === false
		? "candidate-verified-only"
		: options.diagnosisBound ? "candidate-fixture" : "candidate-construction";
	const proposed = createCandidate({
		candidateId,
		projectId: PROJECT_ID,
		targetId: PROJECT_ID,
		specId: fixture.specId,
		proposalId: "builder-fixture",
		diagnosisId: source?.diagnosisId ?? null,
		origin: {
			kind: "applied-builder",
			builderRunId: "builder-fixture",
			builderRun: { path: "/evidence/builder_run.json", sha256: HASH },
			builderInput: { path: "/evidence/builder_input.txt", sha256: HASH },
			proposal: { path: "/evidence/proposal.json", sha256: PROPOSAL_HASH },
			applyReceipt: { path: "/evidence/apply_receipt.json", sha256: HASH },
			application: {
				actor: human(),
				reason: APPLY_REASON,
				appliedAt: "2026-08-30T09:00:00.000Z",
				baseTargetSha: BASE_SHA,
				candidateSha: CANDIDATE_SHA,
				proposalSha256: PROPOSAL_HASH,
			},
			source,
			approvedSpec: {
				specId: fixture.specId,
				projectId: PROJECT_ID,
				specContentHash: HASH,
				snapshotHash: HASH,
				artifact: { path: "/evidence/spec.json", sha256: HASH },
			},
		},
		mode: "candidate",
		baseline: { ref: "refs/heads/master", sha: BASE_SHA },
		eventId: "fixture-proposed",
		at: "2026-08-30T10:00:00.000Z",
		actor: human(),
	});
	const built = transitionCandidate(proposed, {
		type: "built",
		eventId: "fixture-built",
		at: "2026-08-30T10:01:00.000Z",
		actor: human(),
		candidate: { ref: "refs/heads/candidate/builder-fixture", sha: CANDIDATE_SHA },
	});
	const validated = transitionCandidate(built, {
		type: "validated",
		eventId: "fixture-validated",
		at: "2026-08-30T10:02:00.000Z",
		actor: system,
		lineage: {
			baseline: { ref: "refs/heads/master", sha: BASE_SHA },
			candidate: { ref: "refs/heads/candidate/builder-fixture", sha: CANDIDATE_SHA },
			relation: "descendant",
		},
		scope: {
			policyId: "candidate-harness-resources-v3",
			baselineSha: BASE_SHA,
			candidateSha: CANDIDATE_SHA,
			passed: true,
			changedFiles: ["AGENTS.md"],
			violations: [],
		},
	});
	const evaluated = transitionCandidate(validated, {
		type: "evaluated",
		eventId: "fixture-evaluated",
		at: "2026-08-30T10:03:00.000Z",
		actor: system,
		evaluation: {
			experimentId: "experiment-fixture",
			designHash: HASH,
			mode: "candidate",
			development: {
				baseline: { evalRunId: "erun-dev-baseline", harness: { ref: "refs/heads/master", sha: BASE_SHA } },
				candidate: {
					evalRunId: "erun-dev-candidate",
					harness: { ref: "refs/heads/candidate/builder-fixture", sha: CANDIDATE_SHA },
				},
				comparison: comparison({ sealed: false, tasks: 6, repetitions: 2, verdict: "improved" }),
				corpus: fixture.developmentCorpus,
			},
			sealedHoldout: {
				baseline: { evalRunId: "erun-sealed-baseline", harness: { ref: "refs/heads/master", sha: BASE_SHA } },
				candidate: {
					evalRunId: "erun-sealed-candidate",
					harness: { ref: "refs/heads/candidate/builder-fixture", sha: CANDIDATE_SHA },
				},
				comparison: comparison({ sealed: true, tasks: 18, repetitions: 2, verdict: "pass" }),
				corpus: fixture.sealedCorpus,
			},
			infrastructureErrors: 0,
		},
	});
	const reviewed = transitionCandidate(evaluated, {
		type: "reviewed",
		eventId: "fixture-reviewed",
		at: "2026-08-30T10:04:00.000Z",
		actor: human(),
		review: {
			experimentId: "experiment-fixture",
			recommendation: "promote",
			reason: "Development improved; sealed guardrail passed.",
		},
	});
	if (options.promote === false) return reviewed;
	return transitionCandidate(reviewed, {
		type: "promoted",
		eventId: "fixture-promoted",
		at: "2026-08-30T10:05:00.000Z",
		actor: human(),
		decision: {
			experimentId: "experiment-fixture",
			candidate: { ref: "refs/heads/candidate/builder-fixture", sha: CANDIDATE_SHA },
			tag: "v0.1.0",
			reason: "Ship the reviewed returns-policy candidate.",
		},
	});
}

/** An A/A record of the same baseline revision: the calibrated noise band. */
function calibrationRecord(): CandidateRecord {
	const proposed = createCandidate({
		candidateId: "candidate-aa",
		projectId: PROJECT_ID,
		targetId: PROJECT_ID,
		proposalId: "aa-fixture",
		diagnosisId: null,
		mode: "aa-calibration",
		baseline: { ref: "refs/heads/master", sha: BASE_SHA },
		eventId: "aa-proposed",
		at: "2026-08-29T10:00:00.000Z",
		actor: human(),
	});
	const built = transitionCandidate(proposed, {
		type: "built",
		eventId: "aa-built",
		at: "2026-08-29T10:01:00.000Z",
		actor: human(),
		candidate: { ref: "refs/heads/master", sha: BASE_SHA },
	});
	const validated = transitionCandidate(built, {
		type: "validated",
		eventId: "aa-validated",
		at: "2026-08-29T10:02:00.000Z",
		actor: system,
		lineage: {
			baseline: { ref: "refs/heads/master", sha: BASE_SHA },
			candidate: { ref: "refs/heads/master", sha: BASE_SHA },
			relation: "same",
		},
		scope: {
			policyId: "candidate-harness-resources-v3",
			baselineSha: BASE_SHA,
			candidateSha: BASE_SHA,
			passed: true,
			changedFiles: [],
			violations: [],
		},
	});
	return transitionCandidate(validated, {
		type: "evaluated",
		eventId: "aa-evaluated",
		at: "2026-08-29T10:03:00.000Z",
		actor: system,
		evaluation: {
			experimentId: "experiment-aa",
			designHash: HASH,
			mode: "aa-calibration",
			development: {
				baseline: { evalRunId: "erun-aa-left", harness: { ref: "refs/heads/master", sha: BASE_SHA } },
				candidate: { evalRunId: "erun-aa-right", harness: { ref: "refs/heads/master", sha: BASE_SHA } },
				comparison: {
					...comparison({
						sealed: false,
						tasks: 6,
						repetitions: 3,
						verdict: "inconclusive",
						passRates: { baseline: 0.5, candidate: 0.5 },
					}),
					summary: {
						taskCount: 6,
						baselinePassRate: 0.5,
						candidatePassRate: 0.5,
						delta: 0,
						baselineScore: 0.5,
						candidateScore: 0.5,
						scoreDelta: 0,
						confidence95: { low: -0.08, high: 0.08 },
						improved: 1,
						regressed: 1,
						unchanged: 4,
					},
					flags: { regressedTasks: 1, improvedTasks: 1, collapsedTasks: 0 },
				},
			},
			infrastructureErrors: 0,
		},
	});
}

function persist(record: CandidateRecord, runsRoot: string): void {
	mkdirSync(join(runsRoot, "candidates", record.candidateId), { recursive: true });
	writeJsonArtifact(
		candidateRecordPath(runsRoot, record.candidateId),
		CandidateRecordSchema,
		CandidateRecordSchema.parse(record),
	);
}

function passport(overrides: { candidateId?: string; tag?: string } = {}): VersionPassport {
	return compileVersionPassport({
		targetDir: fixture.dir,
		runsRoot: fixture.runsRoot,
		stateRoot: fixture.stateRoot,
		...overrides,
	});
}

beforeAll(() => {
	const dir = makeTargetFixture(baseFixtureFiles());
	const runsRoot = join(dir, "runs");
	const stateRoot = join(dir, ".ahde");
	mkdirSync(runsRoot, { recursive: true });
	mkdirSync(stateRoot, { recursive: true });

	const snapshot = saveSpecSnapshot({
		stateRoot,
		projectId: PROJECT_ID,
		status: "approved",
		spec: {
			schemaVersion: 1,
			title: "Агент поддержки по возвратам",
			purpose: "Отвечать покупателям про сроки и порядок возврата.",
			users: ["покупатель интернет-магазина"],
			jobs: ["ответить на вопрос о сроке возврата"],
			inputs: ["сообщение покупателя на русском"],
			allowedActions: ["ответить текстом"],
			successCriteria: ["ответ по-русски", "срок возврата — 30 дней с даты доставки"],
			constraints: ["без инструментов", "без сети"],
			openQuestions: ["нужен ли англоязычный ответ"],
		},
	});
	const development = createCorpus({
		stateRoot,
		projectId: PROJECT_ID,
		name: "Возвраты — development",
		visibility: "development",
		tasks: corpusTasks("dev", 6),
	});
	const sealed = createCorpus({
		stateRoot,
		projectId: PROJECT_ID,
		name: SEALED_CORPUS_NAME,
		visibility: "sealed",
		tasks: corpusTasks("sealed", 18),
	});

	fixture = {
		dir,
		runsRoot,
		stateRoot,
		specId: snapshot.id,
		developmentCorpus: { id: development.id, hash: development.hash },
		sealedCorpus: { id: sealed.id, hash: sealed.hash },
	};
	persist(promotedRecord({ diagnosisBound: true }), runsRoot);
	persist(calibrationRecord(), runsRoot);
});

afterAll(() => {
	if (fixture?.dir) cleanup(fixture.dir);
});

describe("version passport", () => {
	it("puts the approved promise beside the measured evidence for the newest promotion", () => {
		const page = renderVersionPassportMarkdown(passport());

		expect(page).toContain("# Version passport — test-target v0.1.0");
		expect(page).toContain("- version: v0.1.0");
		expect(page).toContain("- date: 2026-08-30");
		expect(page).toContain(`- revision: ${BASE_SHA.slice(0, 10)} → ${CANDIDATE_SHA.slice(0, 10)}`);
		expect(page).toContain("- model: qwen-internal/qwen3.5-27b");

		// Promised: the approved Spec's own bullets, verbatim, under its own id.
		expect(page).toContain(`## Promised — ${fixture.specId.slice(0, "spec-".length + 12)}…`);
		expect(page).toContain("- срок возврата — 30 дней с даты доставки");
		expect(page).toContain("- без сети");

		// Measured: the score the gate decided on, its interval, the design, the
		// pass rate behind it, and — on six cases — that six is not many.
		expect(page).toContain(
			"- development: **improved** — score 0% → 100% (+100 pts, 95% CI +42 … +86) on 6 cases × 2 · " +
				"pass rate 0% → 100% · 6 cases is a small basket: read the interval as indicative, not decisive",
		);
		expect(page).toContain("- sealed guardrail: **pass** on 18 tasks × 2 repetitions");
		expect(page).toContain("- per answer, candidate over baseline: cost ×1.25 · latency ×0.87 · tokens ×1.10");

		// The A/A record of the same revision is the noise band.
		expect(page).toContain(
			`- calibrated noise band: 95% CI -8.0pp … +8.0pp from an A/A run of ${BASE_SHA.slice(0, 10)} ` +
				"on 6 tasks × 3 repetitions",
		);
		expect(page).toContain("- data: development “Возвраты — development”");
		expect(page).toContain("sealed exam (18 cases)");

		// Provenance is the audit chain, hashes cut to twelve characters.
		expect(page).toContain(`- proposal: sha256:${"d".repeat(12)}…`);
		expect(page).toContain("- gate policies: development-ci-v4, sealed-guardrail-v4");
		expect(page).toContain("- eval runs: development erun-dev-baseline → erun-dev-candidate");
		expect(page).toContain(`- applied by: local-user — ${APPLY_REASON}`);
	});

	it("says the judge is not calibrated when no human label covers the evidence", () => {
		expect(renderVersionPassportMarkdown(passport())).toContain("judge not calibrated");
	});

	it("selects by candidate id and by promotion tag, and `latest` is the default", () => {
		const byTag = passport({ tag: "v0.1.0" });
		const byId = passport({ candidateId: "candidate-fixture" });

		expect(byTag.candidateId).toBe("candidate-fixture");
		expect(byId.versionTag).toBe("v0.1.0");
		expect(byId).toEqual(passport());
		// `ahde passport latest` and `ahde passport` are the same invocation.
		expect(parseCliInvocation(["passport", "--target", "."])).toMatchObject({ positionals: [] });
		expect(parseCliInvocation(["passport", "--target", ".", "latest"])).toMatchObject({
			command: "passport",
			positionals: ["latest"],
		});
		expect(() => parseCliInvocation(["passport", "--target", ".", "--candidate", "c", "--tag", "v0.1.0"]))
			.toThrow(/cannot combine --candidate with --tag/);
	});

	it("carries the whole projection, hashes intact, behind --json", () => {
		const projection = passport();

		expect(projection).toMatchObject({
			schemaVersion: 1,
			agentId: PROJECT_ID,
			projectId: PROJECT_ID,
			candidateId: "candidate-fixture",
			promoted: true,
			versionTag: "v0.1.0",
			at: "2026-08-30T10:05:00.000Z",
			revisions: { baselineSha: BASE_SHA, candidateSha: CANDIDATE_SHA },
			model: { provider: "qwen-internal", id: "qwen3.5-27b" },
		});
		expect(Object.keys(projection)).toEqual([
			"schemaVersion",
			"agentId",
			"projectId",
			"candidateId",
			"promoted",
			"versionTag",
			"at",
			"revisions",
			"model",
			"promised",
			"measured",
			"judge",
			"limits",
			"provenance",
		]);
		expect(projection.promised.specId).toBe(fixture.specId);
		expect(projection.provenance.proposalHash).toBe(PROPOSAL_HASH);
		expect(projection.provenance.appliedBy).toEqual({
			actorId: "local-user",
			reason: APPLY_REASON,
			at: "2026-08-30T09:00:00.000Z",
		});
		expect(projection.measured.sealed).toEqual({ verdict: "pass", design: { tasks: 18, repetitions: 2 } });
		expect(projection.limits.dataset.sealed).toEqual({ cases: 18, origin: null });
		expect(projection.judge).toMatchObject({ stats: null, majorityClassBaseline: null });
		// The projection is JSON, exactly as `--json` prints it.
		expect(JSON.parse(JSON.stringify(projection))).toEqual(projection);
	});

	it("says nothing about the sealed exam but its verdict and its size", () => {
		const projection = passport();
		const page = renderVersionPassportMarkdown(projection);
		const json = JSON.stringify(projection);

		for (const text of [page, json]) {
			expect(text).not.toContain(SEALED_CORPUS_NAME);
			expect(text).not.toContain(fixture.sealedCorpus.id);
			expect(text).not.toContain(fixture.sealedCorpus.hash);
			expect(text).not.toContain("sealed-1");
		}
		// The verdict and the design size are the whole of what may be said.
		expect(page).toContain("**pass** on 18 tasks × 2 repetitions");
	});

	it("refuses with a next step when nothing is promoted and no candidate is named", () => {
		const empty = makeTargetFixture(baseFixtureFiles());
		mkdirSync(join(empty, "runs"), { recursive: true });
		mkdirSync(join(empty, ".ahde"), { recursive: true });
		try {
			let thrown: unknown;
			try {
				compileVersionPassport({
					targetDir: empty,
					runsRoot: join(empty, "runs"),
					stateRoot: join(empty, ".ahde"),
				});
			} catch (error) {
				thrown = error;
			}

			// Everything thrown out of a command is exit 2 in `ahde`; what this
			// refusal owes the operator on top of that is the next step.
			expect(thrown).toBeInstanceOf(VersionPassportError);
			expect((thrown as VersionPassportError).message)
				.toMatch(/has no promoted candidate to issue a passport for/);
			expect((thrown as VersionPassportError).next).toMatch(/ahde promote --target/);
			expect((thrown as VersionPassportError).next).toMatch(/--candidate <id>/);
		} finally {
			cleanup(empty);
		}
	});

	it("says `not promoted — verified only` where the version tag would be", () => {
		persist(promotedRecord({ diagnosisBound: true, promote: false }), fixture.runsRoot);
		const verified = passport({ candidateId: "candidate-verified-only" });
		const page = renderVersionPassportMarkdown(verified);

		expect(verified.promoted).toBe(false);
		expect(verified.versionTag).toBeNull();
		// Not promoted, so the date is the instant it was measured.
		expect(verified.at).toBe("2026-08-30T10:03:00.000Z");
		expect(page).toContain("# Version passport — test-target (verified only)");
		expect(page).toContain("- version: not promoted — verified only");
		// It still is not the newest promotion; the default subject is unchanged.
		expect(passport().candidateId).toBe("candidate-fixture");
	});

	it("refuses a candidate whose record cannot be read, and a tag nothing carries", () => {
		expect(() => passport({ candidateId: "candidate-missing" })).toThrow(VersionPassportError);
		expect(() => passport({ tag: "v9.9.9" }))
			.toThrow(/no promoted candidate of project test-target carries the tag v9.9.9/);
	});

	it("says who wrote the exam, and whether anyone read it, without naming it", () => {
		const base = passport();
		const withOrigin = (origin: "judge-generated" | "judge-generated-reviewed") => ({
			...base,
			limits: {
				...base.limits,
				dataset: { ...base.limits.dataset, sealed: { cases: 18, origin } },
			},
		});

		// An exam the operator brought needs no explanation, and gets none.
		expect(renderVersionPassportMarkdown(base)).toContain("sealed exam (18 cases)");

		const unreviewed = renderVersionPassportMarkdown(withOrigin("judge-generated"));
		expect(unreviewed).toContain("sealed exam (18 cases, generated by the judge, sealed unreviewed)");
		const reviewed = renderVersionPassportMarkdown(withOrigin("judge-generated-reviewed"));
		expect(reviewed).toContain("sealed exam (18 cases, generated by the judge, reviewed by the operator)");

		// The clause is the whole of the difference: still no name, id or hash.
		for (const page of [unreviewed, reviewed]) {
			expect(page).not.toContain(SEALED_CORPUS_NAME);
			expect(page).not.toContain(fixture.sealedCorpus.id);
			expect(page).not.toContain(fixture.sealedCorpus.hash);
		}
	});

	it("says a construction change is not diagnosis-bound", () => {
		const construction = makeTargetFixture(baseFixtureFiles());
		const runsRoot = join(construction, "runs");
		mkdirSync(runsRoot, { recursive: true });
		const previous = fixture.runsRoot;
		try {
			persist(promotedRecord({ diagnosisBound: false }), runsRoot);
			const page = renderVersionPassportMarkdown(
				compileVersionPassport({
					targetDir: construction,
					runsRoot,
					// The Spec and the corpora still live in the original state root.
					stateRoot: fixture.stateRoot,
				}),
			);

			expect(page).toContain("- not diagnosis-bound (construction)");
			expect(page).toContain("- calibrated noise band: not measured");
		} finally {
			expect(fixture.runsRoot).toBe(previous);
			cleanup(construction);
		}
	});

	it("is on the command crib and has its own help page", () => {
		expect(cliHelp([])).toContain("log  watch  passport");
		expect(cliHelp([])).toContain("ahde passport --target <dir> [--tag v0.X.0]");
		const help = cliHelp(["passport", "--help"]);
		expect(help).toContain("ahde passport --target <dir> [--project <id>] [latest] [--json] [--out <path>]");
		expect(help).toContain("The sealed holdout contributes its verdict and its design size and");
		expect(help).toContain("Exit 2 when the subject or an artifact the page rests on is missing.");
	});
});
