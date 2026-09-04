import type { CandidateImpact } from "./candidate-impact.js";
import type { ShippedVersionPassport } from "./version-passport.js";
import type { ComparisonResources, ResourceTotals } from "../domain/comparison-gate.js";

/** A missing value is named, never rendered as zero or an empty success. */
export type VersionCardFact<T> =
	| { status: "known"; value: T }
	| { status: "unknown"; reason: string };

export type VersionCardDecisionCode =
	| "improvement-proved"
	| "no-regression-proved"
	| "sealed-pass-unknown"
	| "sealed-failed"
	| "sealed-inconclusive"
	| "sealed-unknown";

export interface VersionCardValidationContext {
	surface: "development" | "blind-validation";
	/** Present only for an immutable blind authoring/validation design. */
	blindDesign: {
		designId: string;
		sourceCases: number;
		authoringCases: number;
		validationCases: number;
	} | null;
}

export interface VersionCardChangeInput {
	summary: string;
	proposalHash: string;
	paths: readonly string[];
	/** Exact, already verified unified diff. The card never edits or truncates it. */
	exactDiff: string;
}

export interface VersionCardArtifactInput {
	path: string;
	sha256: string;
	bytes: number;
}

export interface VersionCardDatasetArtifactInput extends VersionCardArtifactInput {
	dialogues: number;
	evalRunIds: readonly string[];
}

export interface CompileExecutiveVersionCardInput {
	passport: ShippedVersionPassport;
	/** Exact candidate impact, already verified by the application layer. */
	impact?: CandidateImpact | null;
	/** Absolute comparison resources. The passport itself retains only ratios. */
	comparisonResources?: ComparisonResources | null;
	/** Omit when the caller cannot prove which development surface was measured. */
	validationContext?: VersionCardValidationContext | null;
	/** Exact proposal facts, already verified against Candidate provenance. */
	change?: VersionCardChangeInput | null;
	artifacts?: {
		passport?: VersionCardArtifactInput | null;
		dataset?: VersionCardDatasetArtifactInput | null;
	};
}

export interface ExecutiveVersionCard {
	schemaVersion: 1;
	release: {
		agent: string;
		version: string;
		at: string;
		baselineSha: string;
		candidateSha: string;
	};
	decision: { code: VersionCardDecisionCode; headline: string };
	validation: VersionCardFact<{
		context: VersionCardFact<VersionCardValidationContext>;
		verdict: string;
		baseline: { score: number; passRate: number };
		candidate: { score: number; passRate: number };
		scoreDelta: number;
		confidence95: { low: number; high: number };
		design: { tasks: number; repetitions: number; excludedTasks: number };
	}>;
	/** Verdict, outcome and design only. This shape cannot carry sealed identity or content. */
	sealed: VersionCardFact<{
		verdict: string;
		outcome: "improved" | "no-regression" | null;
		design: { tasks: number; repetitions: number };
		origin: VersionCardFact<string>;
	}>;
	capabilities: VersionCardFact<{
		verdict: CandidateImpact["verdict"];
		rows: Array<{
			check: string;
			subject: string | null;
			tasks: number;
			baselinePassed: number;
			candidatePassed: number;
			delta: number;
		}>;
		omitted: number;
	}>;
	regressions: VersionCardFact<{
		tasks: number;
		newFailureModes: number;
		worsenedFailureModes: number;
		targetedUnresolved: number;
	}>;
	resources: {
		arms: VersionCardFact<{ baseline: ResourceTotals; candidate: ResourceTotals }>;
		ratios: VersionCardFact<{ cost: number | null; latency: number | null; tokens: number | null }>;
		judgeCostUsd: VersionCardFact<number>;
	};
	change: VersionCardFact<{
		summary: string;
		proposalHash: string;
		paths: string[];
		files: number;
		addedLines: number;
		removedLines: number;
		exactDiff: string;
	}>;
	artifacts: {
		passport: VersionCardFact<VersionCardArtifactInput>;
		dataset: VersionCardFact<VersionCardDatasetArtifactInput>;
	};
	warnings: string[];
}

const unknown = <T>(reason: string): VersionCardFact<T> => ({ status: "unknown", reason });
const known = <T>(value: T): VersionCardFact<T> => ({ status: "known", value });

function decisionOf(passport: ShippedVersionPassport): ExecutiveVersionCard["decision"] {
	const sealed = passport.measured.sealed;
	if (!sealed) return { code: "sealed-unknown", headline: `${passport.version} released · sealed conclusion unknown` };
	if (sealed.verdict === "pass" && sealed.outcome === "improved") {
		return { code: "improvement-proved", headline: `${passport.version} released · sealed exam proved improvement` };
	}
	if (sealed.verdict === "pass" && sealed.outcome === "no-regression") {
		return { code: "no-regression-proved", headline: `${passport.version} released · sealed exam proved no regression` };
	}
	if (sealed.verdict === "pass") {
		return { code: "sealed-pass-unknown", headline: `${passport.version} released · sealed exam passed, conclusion unknown` };
	}
	if (sealed.verdict === "fail") {
		return { code: "sealed-failed", headline: `${passport.version} recorded · sealed exam failed` };
	}
	return { code: "sealed-inconclusive", headline: `${passport.version} recorded · sealed exam inconclusive` };
}

function validationOf(input: CompileExecutiveVersionCardInput): ExecutiveVersionCard["validation"] {
	const development = input.passport.measured.development;
	if (!development) return unknown("promotion-grade validation evidence was not supplied");
	return known({
		context: input.validationContext
			? known({
				surface: input.validationContext.surface,
				blindDesign: input.validationContext.blindDesign
					? { ...input.validationContext.blindDesign }
					: null,
			})
			: unknown("validation surface was not supplied"),
		verdict: development.verdict,
		baseline: { score: development.baselineScore, passRate: development.baselinePassRate },
		candidate: { score: development.candidateScore, passRate: development.candidatePassRate },
		scoreDelta: development.scoreDelta,
		confidence95: { ...development.confidence95 },
		design: {
			tasks: development.tasks,
			repetitions: development.repetitions,
			excludedTasks: development.excludedTasks,
		},
	});
}

function sealedOf(passport: ShippedVersionPassport): ExecutiveVersionCard["sealed"] {
	const sealed = passport.measured.sealed;
	if (!sealed) return unknown("sealed verdict was not supplied");
	return known({
		verdict: sealed.verdict,
		outcome: sealed.outcome,
		design: { tasks: sealed.tasks, repetitions: sealed.repetitions },
		origin: passport.limits.sealedOrigin
			? known(passport.limits.sealedOrigin)
			: unknown("sealed exam origin was not supplied"),
	});
}

function impactOf(input: CompileExecutiveVersionCardInput): Pick<ExecutiveVersionCard, "capabilities" | "regressions"> {
	const impact = input.impact;
	if (!impact) {
		return {
			capabilities: unknown("candidate impact was not supplied"),
			regressions: unknown("candidate impact was not supplied"),
		};
	}
	const targetedUnresolved = impact.proposalBasis?.targetedFailureModes.filter(
		(mode) => mode.outcome !== "resolved" && mode.outcome !== "improved",
	).length ?? 0;
	return {
		capabilities: known({
			verdict: impact.verdict,
			rows: impact.families.map((family) => ({
				check: family.signature.checkCode,
				subject: family.signature.subject,
				tasks: family.tasks,
				baselinePassed: family.baselinePassedTasks,
				candidatePassed: family.candidatePassedTasks,
				delta: family.candidatePassedTasks - family.baselinePassedTasks,
			})),
			omitted: impact.omittedFamilyCount,
		}),
		regressions: known({
			tasks: impact.taskRegressions.length + impact.omittedTaskRegressionCount,
			newFailureModes: impact.newFailureModes.length + impact.omittedNewFailureModeCount,
			worsenedFailureModes: impact.worsenedFailureModes.length + impact.omittedWorsenedFailureModeCount,
			targetedUnresolved,
		}),
	};
}

function diffStats(exactDiff: string): { addedLines: number; removedLines: number } {
	let addedLines = 0;
	let removedLines = 0;
	for (const line of exactDiff.split(/\r?\n/u)) {
		if (line.startsWith("+") && !line.startsWith("+++")) addedLines += 1;
		if (line.startsWith("-") && !line.startsWith("---")) removedLines += 1;
	}
	return { addedLines, removedLines };
}

function changeOf(input: CompileExecutiveVersionCardInput): ExecutiveVersionCard["change"] {
	if (!input.change) return unknown("exact change was not supplied");
	const paths = [...new Set(input.change.paths)].sort();
	return known({
		summary: input.change.summary,
		proposalHash: input.change.proposalHash,
		paths,
		files: paths.length,
		...diffStats(input.change.exactDiff),
		exactDiff: input.change.exactDiff,
	});
}

function passportArtifact(value: VersionCardArtifactInput | null | undefined): VersionCardFact<VersionCardArtifactInput> {
	return value
		? known({ ...value })
		: unknown("passport artifact was not supplied");
}

function datasetArtifact(
	value: VersionCardDatasetArtifactInput | null | undefined,
): VersionCardFact<VersionCardDatasetArtifactInput> {
	return value
		? known({ ...value, evalRunIds: [...value.evalRunIds] })
		: unknown("dataset artifact was not supplied");
}

/**
 * Compile the one-page release reading from facts a trusted caller has already
 * verified. This function is deliberately pure: it opens no artifact, reads no
 * corpus, and its sealed input is only the redacted passport projection.
 */
export function compileExecutiveVersionCard(input: CompileExecutiveVersionCardInput): ExecutiveVersionCard {
	const impact = impactOf(input);
	const passportResources = input.passport.measured.resources;
	const ratios = input.comparisonResources
		? {
			cost: input.comparisonResources.costRatio,
			latency: input.comparisonResources.latencyRatio,
			tokens: input.comparisonResources.tokenRatio,
		}
		: passportResources
			? {
				cost: passportResources.costRatio,
				latency: passportResources.latencyRatio,
				tokens: passportResources.tokenRatio,
			}
			: null;
	return {
		schemaVersion: 1,
		release: {
			agent: input.passport.agent,
			version: input.passport.version,
			at: input.passport.at,
			baselineSha: input.passport.baselineSha,
			candidateSha: input.passport.candidateSha,
		},
		decision: decisionOf(input.passport),
		validation: validationOf(input),
		sealed: sealedOf(input.passport),
		...impact,
		resources: {
			arms: input.comparisonResources
				? known({
					baseline: { ...input.comparisonResources.baseline },
					candidate: { ...input.comparisonResources.candidate },
				})
				: unknown("absolute comparison resources were not supplied"),
			ratios: ratios ? known(ratios) : unknown("resource ratios were not supplied"),
			judgeCostUsd: passportResources
				? known(passportResources.judgeCostUsd)
				: unknown("judge cost was not supplied"),
		},
		change: changeOf(input),
		artifacts: {
			passport: passportArtifact(input.artifacts?.passport),
			dataset: datasetArtifact(input.artifacts?.dataset),
		},
		warnings: [...input.passport.warnings],
	};
}
