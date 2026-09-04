import { describe, expect, it } from "vitest";
import {
	compileExecutiveVersionCard,
	type CompileExecutiveVersionCardInput,
} from "../src/application/executive-version-card.js";
import type { CandidateImpact } from "../src/application/candidate-impact.js";
import type { ShippedVersionPassport } from "../src/application/version-passport.js";
import type { ComparisonResources } from "../src/domain/comparison-gate.js";
import { renderExecutiveVersionCard } from "../src/builder/render/version-card.js";
import { plainPaint } from "../src/builder/render/paint.js";

function passport(overrides: Partial<ShippedVersionPassport> = {}): ShippedVersionPassport {
	return {
		schemaVersion: 1,
		agent: "support-agent",
		version: "v0.2.0",
		at: "2026-09-04T12:00:00.000Z",
		baselineSha: "a".repeat(40),
		candidateSha: "b".repeat(40),
		model: { provider: "openai", id: "gpt-test" },
		promised: null,
		measured: {
			development: {
				verdict: "improved",
				tasks: 12,
				repetitions: 3,
				excludedTasks: 1,
				baselinePassRate: 0.42,
				candidatePassRate: 0.81,
				baselineScore: 0.44,
				candidateScore: 0.83,
				scoreDelta: 0.39,
				confidence95: { low: 0.24, high: 0.53 },
			},
			sealed: { verdict: "pass", tasks: 20, repetitions: 2, outcome: "improved" },
			resources: { costRatio: 1.21, latencyRatio: 1.09, tokenRatio: 1.04, judgeCostUsd: 0.08 },
			predicted: null,
		},
		judge: null,
		limits: {
			unresolvedModes: [],
			unresolvedOmitted: 0,
			noise: null,
			developmentCorpus: { id: "development-visible", hash: `sha256:${"c".repeat(64)}` },
			sealedTasks: 20,
			sealedOrigin: "judge-generated-reviewed",
		},
		provenance: {
			candidateId: "cand-1",
			experimentId: "experiment-1",
			approvedSpecId: null,
			proposalRunId: "builder-1",
			proposalSha256: `sha256:${"d".repeat(64)}`,
			appliedBy: "operator",
			appliedVia: "proposal-search",
			reviewedBy: "operator",
			promotedBy: "operator",
			reason: "measured win",
			developmentEvalRuns: { baseline: "erun-base", candidate: "erun-candidate" },
			predictionCalibration: { scored: 0, hits: 0, meanAbsoluteErrorPp: null, strip: [], unpredicted: 0 },
		},
		warnings: [],
		...overrides,
	};
}

function impact(): CandidateImpact {
	return {
		verdict: "mixed",
		families: [
			{
				signature: { checkCode: "required-tool", subject: "search", kind: "grader-check", discriminatorHash: `sha256:${"1".repeat(64)}` },
				tasks: 6,
				baselinePassedTasks: 2,
				candidatePassedTasks: 6,
				fixedTaskIds: ["a", "b", "c", "d"],
				regressedTaskIds: [],
				failureModeId: `fm-${"1".repeat(24)}`,
				category: "tool-use",
			},
		],
		omittedFamilyCount: 2,
		taskRegressions: [{ taskId: "public-task", baselinePassRate: 1, candidatePassRate: 0.5, delta: -0.5, evidence: [] }],
		omittedTaskRegressionCount: 1,
		newFailureModes: [{}],
		omittedNewFailureModeCount: 2,
		worsenedFailureModes: [{}],
		omittedWorsenedFailureModeCount: 3,
		proposalBasis: {
			targetedFailureModes: [{ outcome: "persisted" }, { outcome: "resolved" }],
		},
	} as unknown as CandidateImpact;
}

const comparisonResources: ComparisonResources = {
	baseline: { runs: 36, costUsd: 0.42, meanLatencyMs: 740, meanTokens: 800 },
	candidate: { runs: 36, costUsd: 0.51, meanLatencyMs: 810, meanTokens: 832 },
	costRatio: 1.21,
	latencyRatio: 1.09,
	tokenRatio: 1.04,
};

function completeInput(): CompileExecutiveVersionCardInput {
	return {
		passport: passport(),
		impact: impact(),
		comparisonResources,
		validationContext: {
			surface: "blind-validation",
			blindDesign: { designId: "design-1", sourceCases: 20, authoringCases: 8, validationCases: 12 },
		},
		change: {
			summary: "Make retrieval answers cite their source",
			proposalHash: `sha256:${"e".repeat(64)}`,
			paths: ["prompt.md", "prompt.md", "tools/search.yaml"],
			exactDiff: [
				"diff --git a/prompt.md b/prompt.md",
				"--- a/prompt.md",
				"+++ b/prompt.md",
				"-Answer briefly.",
				"+Answer briefly and cite the source.",
				"+Do not invent citations.",
			].join("\n"),
		},
		artifacts: {
			passport: { path: "passport-v0.2.0.md", sha256: `sha256:${"f".repeat(64)}`, bytes: 2048 },
			dataset: {
				path: "exports/erun-candidate.jsonl",
				sha256: `sha256:${"0".repeat(64)}`,
				bytes: 4096,
				dialogues: 36,
				evalRunIds: ["erun-candidate"],
			},
		},
	};
}

describe("Executive Version Card", () => {
	it("unifies the exact release facts without re-deciding the sealed verdict", () => {
		const card = compileExecutiveVersionCard(completeInput());

		expect(card.decision).toEqual({
			code: "improvement-proved",
			headline: "v0.2.0 released · sealed exam proved improvement",
		});
		expect(card.validation).toMatchObject({
			status: "known",
			value: {
				context: { status: "known", value: { surface: "blind-validation" } },
				baseline: { score: 0.44, passRate: 0.42 },
				candidate: { score: 0.83, passRate: 0.81 },
				scoreDelta: 0.39,
			},
		});
		expect(card.sealed).toEqual({
			status: "known",
			value: {
				verdict: "pass",
				outcome: "improved",
				design: { tasks: 20, repetitions: 2 },
				origin: { status: "known", value: "judge-generated-reviewed" },
			},
		});
		expect(card.capabilities).toMatchObject({
			status: "known",
			value: { rows: [{ check: "required-tool", subject: "search", baselinePassed: 2, candidatePassed: 6, delta: 4 }], omitted: 2 },
		});
		expect(card.regressions).toEqual({
			status: "known",
			value: { tasks: 2, newFailureModes: 3, worsenedFailureModes: 4, targetedUnresolved: 1 },
		});
		expect(card.change).toMatchObject({
			status: "known",
			value: { files: 2, addedLines: 2, removedLines: 1, paths: ["prompt.md", "tools/search.yaml"] },
		});
		expect(card.artifacts.dataset).toMatchObject({ status: "known", value: { dialogues: 36 } });
	});

	it.each([
		["no-regression" as const, "no-regression-proved", "sealed exam proved no regression"],
		[null, "sealed-pass-unknown", "sealed exam passed, conclusion unknown"],
	])("distinguishes a sealed %s finding from proved improvement", (outcome, code, headline) => {
		const value = passport();
		value.measured.sealed = { verdict: "pass", tasks: 20, repetitions: 2, outcome };
		const card = compileExecutiveVersionCard({ passport: value });

		expect(card.decision.code).toBe(code);
		expect(card.decision.headline).toContain(headline);
		expect(card.decision.headline).not.toContain("proved improvement");
	});

	it("copies caller-owned arrays and retains the complete exact diff outside the compact renderer", () => {
		const input = completeInput();
		const card = compileExecutiveVersionCard(input);
		(input.change!.paths as string[])[0] = "tampered";
		(input.artifacts!.dataset!.evalRunIds as string[])[0] = "tampered";

		expect(card.change.status === "known" && card.change.value.paths).toEqual(["prompt.md", "tools/search.yaml"]);
		expect(card.artifacts.dataset.status === "known" && card.artifacts.dataset.value.evalRunIds).toEqual(["erun-candidate"]);
		expect(card.change.status === "known" && card.change.value.exactDiff).toContain("Do not invent citations");
		expect(renderExecutiveVersionCard(card, plainPaint).join("\n")).not.toContain("Do not invent citations");
	});

	it("keeps every absent measurement explicitly unknown instead of inventing zero", () => {
		const base = passport({
			measured: { development: null, sealed: null, resources: null, predicted: null },
			limits: {
				unresolvedModes: [], unresolvedOmitted: 0, noise: null,
				developmentCorpus: null, sealedTasks: 0, sealedOrigin: null,
			},
		});
		const card = compileExecutiveVersionCard({ passport: base });

		expect(card.decision.code).toBe("sealed-unknown");
		for (const fact of [card.validation, card.sealed, card.capabilities, card.regressions, card.change]) {
			expect(fact.status).toBe("unknown");
		}
		expect(card.resources.arms.status).toBe("unknown");
		expect(card.resources.ratios.status).toBe("unknown");
		expect(card.artifacts.passport.status).toBe("unknown");
		expect(card.artifacts.dataset.status).toBe("unknown");
		expect(renderExecutiveVersionCard(card, plainPaint).join("\n")).toContain("unknown (");
	});

	it("projects only the sealed verdict, outcome, design and origin", () => {
		const unsafe = passport();
		Object.assign(unsafe.measured.sealed as object, {
			corpusId: "sealed-secret-id",
			caseText: "secret exam question",
			evalRunIds: ["sealed-run"],
		});
		const serialized = JSON.stringify(compileExecutiveVersionCard({ passport: unsafe }));

		expect(serialized).not.toContain("sealed-secret-id");
		expect(serialized).not.toContain("secret exam question");
		expect(serialized).not.toContain("sealed-run");
		expect(serialized).toContain('"tasks":20');
	});

	it("renders a concise executive reading of known facts", () => {
		const lines = renderExecutiveVersionCard(compileExecutiveVersionCard(completeInput()), plainPaint);
		const rendered = lines.join("\n");

		expect(lines.length).toBeLessThanOrEqual(12);
		expect(rendered).toContain("VERSION CARD · support-agent v0.2.0");
		expect(rendered).toContain("blind validation · score 44.0% → 83.0%");
		expect(rendered).toContain("Sealed exam improvement proved · 20 cases × 2");
		expect(rendered).toContain("required-tool search 2/6 → 6/6");
		expect(rendered).toContain("2 task regressions · 3 new modes · 4 worsened modes");
		expect(rendered).toContain("$0.420 / 740 ms → $0.510 / 810 ms");
		expect(rendered).toContain("2 files · +2 -1");
		expect(rendered).toContain("36 dialogues");
	});
});
