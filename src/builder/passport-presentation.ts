import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { AhdeWorkbench } from "../workbench/workbench.js";
import type { WorkbenchView } from "../workbench/types.js";
import { inspectCandidateImpact, type CandidateImpact } from "../application/candidate-impact.js";
import {
	compileExecutiveVersionCard,
	type VersionCardArtifactInput,
	type VersionCardChangeInput,
	type VersionCardDatasetArtifactInput,
	type VersionCardValidationContext,
} from "../application/executive-version-card.js";
import {
	corpusTaskLookup,
	exportDataset,
	sealedDatasetHashesFor,
} from "../application/export-dataset.js";
import { loadCandidateRecord } from "../application/candidate-review.js";
import { loadImprovementExperimentDesign } from "../application/improvement-experiment-design.js";
import {
	compileVersionPassport,
	renderVersionPassportMarkdown,
} from "../application/version-passport.js";
import { isPromotionGradeGateEvidence, type CandidateRecord } from "../domain/candidate.js";
import type { ComparisonResources } from "../domain/comparison-gate.js";
import { hashValue } from "../provenance.js";
import { writeTextArtifact } from "../storage/artifacts.js";
import { candidateProposalReview } from "../workbench/resolution.js";
import { renderVersionCardHtml } from "../evidence/version-card.js";

type PassportWorkbench = Pick<
	AhdeWorkbench,
	"view" | "projectDir" | "stateRoot" | "runsRoot" | "projectId"
>;

function sha256(content: string | Buffer): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function exactCandidate(
	workbench: PassportWorkbench,
	passport: ReturnType<typeof compileVersionPassport>,
): CandidateRecord | null {
	try {
		const record = loadCandidateRecord(workbench.runsRoot, passport.provenance.candidateId);
		const built = record.events.find((event) => event.type === "built");
		if (
			record.projectId !== workbench.projectId ||
			record.targetId !== passport.agent ||
			record.baseline.sha !== passport.baselineSha ||
			built?.type !== "built" ||
			built.candidate.sha !== passport.candidateSha
		) return null;
		return record;
	} catch {
		return null;
	}
}

function verifiedImpact(
	workbench: PassportWorkbench,
	record: CandidateRecord | null,
): CandidateImpact | null {
	if (!record) return null;
	try {
		return inspectCandidateImpact({
			runsRoot: workbench.runsRoot,
			stateRoot: workbench.stateRoot,
			candidateId: record.candidateId,
			expectedCandidateHash: hashValue(record),
		});
	} catch {
		return null;
	}
}

function verifiedValidationContext(
	record: CandidateRecord | null,
	impact: CandidateImpact | null,
): VersionCardValidationContext | null {
	if (!record) return null;
	if (record.origin.kind !== "applied-builder" || !record.origin.experimentDesign) {
		return { surface: "development", blindDesign: null };
	}
	// Candidate impact re-verifies the design's canonical location, artifact
	// hash, corpus identities and its relation to the exact development arms.
	if (!impact) return null;
	try {
		const reference = record.origin.experimentDesign;
		const path = resolve(reference.path);
		const entry = lstatSync(path);
		if (!entry.isFile() || entry.isSymbolicLink()) return null;
		const design = loadImprovementExperimentDesign(path);
		if (sha256(readFileSync(path)) !== reference.sha256) return null;
		return {
			surface: "blind-validation",
			blindDesign: {
				designId: design.designId,
				sourceCases: design.sourceCorpus.taskCount,
				authoringCases: design.authoringCorpus.taskCount,
				validationCases: design.validationCorpus.taskCount,
			},
		};
	} catch {
		return null;
	}
}

function verifiedChange(
	workbench: PassportWorkbench,
	record: CandidateRecord | null,
): VersionCardChangeInput | null {
	if (!record) return null;
	try {
		const review = candidateProposalReview(workbench.runsRoot, record);
		return review
			? {
				summary: review.summary,
				proposalHash: review.proposalHash,
				paths: review.paths,
				exactDiff: review.exactDiff,
			}
			: null;
	} catch {
		return null;
	}
}

function verifiedResources(record: CandidateRecord | null, impact: CandidateImpact | null): ComparisonResources | null {
	if (!record || !impact) return null;
	const evaluated = record.events.find((event) => event.type === "evaluated");
	const comparison = evaluated?.type === "evaluated"
		? evaluated.evaluation.development.comparison
		: null;
	return isPromotionGradeGateEvidence(comparison) ? comparison.resources : null;
}

function versionDatasetArtifact(
	workbench: PassportWorkbench,
	passport: ReturnType<typeof compileVersionPassport>,
): VersionCardDatasetArtifactInput | null {
	const evalRunId = passport.provenance.developmentEvalRuns?.candidate;
	if (!evalRunId) return null;
	try {
		const scope = { stateRoot: workbench.stateRoot, projectId: workbench.projectId };
		const exported = exportDataset({
			runsRoot: workbench.runsRoot,
			outRoot: workbench.projectDir,
			evalRunId,
			includeFailed: true,
			sealedDatasetHashes: sealedDatasetHashesFor(scope),
			tasks: corpusTaskLookup(scope),
		});
		if (exported.counts.exported === 0) return null;
		const content = readFileSync(exported.path);
		const path = relative(workbench.projectDir, exported.path).replaceAll("\\", "/");
		if (!path || path === ".." || path.startsWith("../")) return null;
		return {
			path,
			sha256: sha256(content),
			bytes: content.byteLength,
			dialogues: exported.counts.exported,
			evalRunIds: exported.evalRunIds,
		};
	} catch {
		return null;
	}
}

/** The one Builder seam used by conversational Ship and explicit export. */
export async function compileBuilderPassport(
	workbench: PassportWorkbench,
	options: { version?: string; view?: WorkbenchView; save?: boolean } = {},
) {
	const view = options.view ?? await workbench.view();
	const passport = compileVersionPassport({
		runsRoot: workbench.runsRoot,
		stateRoot: workbench.stateRoot,
		projectId: workbench.projectId,
		...(options.version ? { version: options.version } : {}),
		...(view.target.id ? { targetId: view.target.id } : {}),
		model: view.target.model ? { provider: view.target.model.provider, id: view.target.model.id } : null,
	});
	const slug = passport.version.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
	const name = `passport-${slug.startsWith("v") ? slug : `v${slug}`}.md`;
	const markdown = renderVersionPassportMarkdown(passport);
	let written: string | null = null;
	let passportArtifact: VersionCardArtifactInput | null = null;
	let datasetArtifact: VersionCardDatasetArtifactInput | null = null;
	if (options.save === true) {
		written = resolve(workbench.projectDir, name);
		try {
			writeTextArtifact(written, markdown);
			passportArtifact = {
				path: name,
				sha256: sha256(markdown),
				bytes: Buffer.byteLength(markdown, "utf8"),
			};
		} catch {
			// The page remains useful in the Builder even when the checkout is read-only.
			written = null;
		}
		datasetArtifact = versionDatasetArtifact(workbench, passport);
	}
	const candidate = exactCandidate(workbench, passport);
	const impact = verifiedImpact(workbench, candidate);
	const card = compileExecutiveVersionCard({
		passport,
		impact,
		comparisonResources: verifiedResources(candidate, impact),
		validationContext: verifiedValidationContext(candidate, impact),
		change: verifiedChange(workbench, candidate),
		artifacts: { passport: passportArtifact, dataset: datasetArtifact },
	});
	let reportWritten: string | null = null;
	if (options.save === true) {
		const path = `exports/version-${slug.startsWith("v") ? slug : `v${slug}`}.html`;
		try {
			reportWritten = resolve(workbench.projectDir, path);
			writeTextArtifact(reportWritten, renderVersionCardHtml(card));
		} catch {
			reportWritten = null;
			// Export failure cannot undo a recorded release or hide its terminal evidence.
		}
	}
	return { passport, card, written, reportWritten };
}
