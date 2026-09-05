import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	candidateArtifactReference, readCandidateArtifact, resolveCandidateArtifact,
	type AppliedCandidateOrigin, type CandidateArtifactKind,
} from "../src/application/candidate-artifacts.js";
import { runAppliedBuilderCandidate } from "../src/application/builder-candidate.js";
import { inspectCandidateImpact } from "../src/application/candidate-impact.js";
import { candidateRecordPath, loadCandidateRecord } from "../src/application/candidate-review.js";
import { compileHarnessAuthoringProposal } from "../src/application/harness-authoring.js";
import { improvementDesignCorpusRefs, loadImprovementExperimentDesign } from "../src/application/improvement-experiment-design.js";
import { improvementLoopGate, runImprovementLoop } from "../src/application/improvement-loop.js";
import { candidateStatus } from "../src/domain/candidate.js";
import { hashValue } from "../src/provenance.js";
import { createAhdeWorkbench } from "../src/workbench/index.js";
import { candidateProposalReview } from "../src/workbench/resolution.js";
import { approvingGate, improveFixture, READY_INSTRUCTION, type ImproveFixture } from "./helpers/improve-fixtures.js";

const KINDS: CandidateArtifactKind[] = ["builderRun", "builderInput", "proposal", "applyReceipt", "sourceEval", "sourceDiagnosis", "approvedSpec", "experimentDesign"];
function applied(record: ReturnType<typeof loadCandidateRecord>): AppliedCandidateOrigin {
	if (record.origin.kind !== "applied-builder") throw new Error("expected applied Builder origin");
	return record.origin;
}
function copyProject(source: string): string {
	const destination = realpathSync(mkdtempSync(join(tmpdir(), "ahde-portable-")));
	cpSync(source, destination, { recursive: true });
	return destination;
}

describe("portable exact Candidate provenance", () => {
	let fixture: ImproveFixture;
	let candidateId: string;
	beforeAll(async () => {
		fixture = await improveFixture({}, { developmentCases: 4, repetitions: 2 });
		const result = await runImprovementLoop({
			repositoryDir: fixture.projectDir, runsRoot: fixture.runsRoot, stateRoot: fixture.stateRoot,
			projectId: fixture.projectId, approvedSpecId: fixture.approvedSpecId,
			developmentCorpus: { stateRoot: fixture.stateRoot, projectId: fixture.projectId, corpusId: fixture.corpusId },
			loopId: "loop_portability", selection: "best", executionBudget: 100, maxCycles: 1, repetitions: 2, until: 1,
			gate: improvementLoopGate(approvingGate()),
			author: (request) => ({
				kind: "propose",
				proposal: compileHarnessAuthoringProposal({
					repositoryDir: request.repositoryDir, expectedBaseTargetSha: request.baseTargetSha,
					intents: [{ type: "instructions.replace", content: `# Portable candidate\n\n${READY_INSTRUCTION}\n` }],
					summary: "Answer the requested uppercase word", diagnoses: request.selection.diagnoses,
					risks: ["Instruction behavior changes"], validationPlan: ["Measure unchanged blind validation cases"],
				}),
			}),
		});
		expect(result.candidateId).not.toBeNull();
		candidateId = result.candidateId!;
		expect(candidateStatus(loadCandidateRecord(fixture.runsRoot, candidateId))).toBe("evaluated");
	});
	afterAll(async () => { await fixture?.close(); });

	it("writes only relative refs, copies exact approved Spec bytes, and re-verifies the copied project while the old artifacts are poisoned", async () => {
		const original = loadCandidateRecord(fixture.runsRoot, candidateId);
		const origin = applied(original);
		const originalBytes = readFileSync(candidateRecordPath(fixture.runsRoot, candidateId));
		for (const kind of KINDS) {
			const ref = candidateArtifactReference(origin, kind);
			expect(isAbsolute(ref.path), kind).toBe(false);
			expect(ref.path, kind).not.toContain("\\");
			expect(ref.path, kind).not.toContain("..");
		}
		expect(readCandidateArtifact(fixture.runsRoot, origin, "approvedSpec").bytes)
			.toEqual(readFileSync(join(fixture.stateRoot, "projects", fixture.projectId, "specs", `${fixture.approvedSpecId}.json`)));
		const destination = copyProject(fixture.projectDir);
		const current = { projectDir: destination, runsRoot: join(destination, "runs"), stateRoot: join(destination, ".ahde"), projectId: fixture.projectId };
		const originalArtifacts = KINDS.map((kind) => readCandidateArtifact(fixture.runsRoot, origin, kind));
		try {
			for (const artifact of originalArtifacts) writeFileSync(artifact.path, "POISONED OLD COPY — MUST NEVER BE OPENED\n");
			const copy = loadCandidateRecord(current.runsRoot, candidateId);
			expect(hashValue(copy)).toBe(hashValue(original));
			expect(readFileSync(candidateRecordPath(current.runsRoot, candidateId))).toEqual(originalBytes);
			const impact = inspectCandidateImpact({ ...current, candidateId });
			expect(impact.verdict).toBe("improved");
			expect(candidateProposalReview(current.runsRoot, copy)?.proposalHash).toBe(origin.proposal.sha256);
			const workbench = createAhdeWorkbench(current);
			const view = await workbench.view({ aspect: "review" });
			expect(view.selections.some((entry) => entry.kind === "candidate" && entry.id === candidateId)).toBe(true);
			expect(view.blockers.join("\n")).not.toMatch(/provenance|hash mismatch|unexpected artifact|invalid candidate/i);
			const designPath = resolveCandidateArtifact(current.runsRoot, origin, "experimentDesign");
			const refs = improvementDesignCorpusRefs(loadImprovementExperimentDesign(designPath), current.stateRoot);
			const verified = await runAppliedBuilderCandidate({
				repositoryDir: destination, runsRoot: current.runsRoot, projectId: fixture.projectId,
				builderRunId: origin.builderRunId, candidateId: "candidate-portable-reverified", repetitions: 2,
				approvedSpec: { stateRoot: current.stateRoot, specId: fixture.approvedSpecId },
				developmentCorpus: refs.authoring, validationCorpus: refs.validation, experimentDesignPath: designPath,
			});
			expect(candidateStatus(verified.record)).toBe("evaluated");
			expect(inspectCandidateImpact({ ...current, candidateId: verified.record.candidateId }).verdict).toBe("improved");
			expect(readFileSync(candidateRecordPath(current.runsRoot, candidateId))).toEqual(originalBytes);
			expect(readFileSync(candidateRecordPath(fixture.runsRoot, candidateId))).toEqual(originalBytes);
			for (const artifact of originalArtifacts) expect(readFileSync(artifact.path, "utf8")).toContain("POISONED OLD COPY");
		} finally {
			for (const artifact of originalArtifacts) writeFileSync(artifact.path, artifact.bytes);
			rmSync(destination, { recursive: true, force: true });
		}
	});

	it.each(["proposal", "approvedSpec", "experimentDesign"] as const)("rejects tampered current %s even when the original copy is intact", (kind) => {
		const destination = copyProject(fixture.projectDir);
		try {
			const runsRoot = join(destination, "runs");
			const origin = applied(loadCandidateRecord(runsRoot, candidateId));
			writeFileSync(resolveCandidateArtifact(runsRoot, origin, kind), "CURRENT TAMPER");
			expect(() => inspectCandidateImpact({ runsRoot, candidateId })).toThrow(/hash mismatch/);
		} finally { rmSync(destination, { recursive: true, force: true }); }
	});

	it.each(["leaf", "ancestor"] as const)("refuses %s symlinks to an otherwise identical old artifact", (surface) => {
		const destination = copyProject(fixture.projectDir);
		try {
			const runsRoot = join(destination, "runs");
			const origin = applied(loadCandidateRecord(runsRoot, candidateId));
			const currentPath = surface === "leaf" ? join(runsRoot, origin.proposal.path) : join(runsRoot, "builders", origin.builderRunId);
			const oldPath = surface === "leaf" ? join(fixture.runsRoot, origin.proposal.path) : join(fixture.runsRoot, "builders", origin.builderRunId);
			rmSync(currentPath, { recursive: true });
			symlinkSync(oldPath, currentPath);
			expect(() => readCandidateArtifact(runsRoot, origin, "proposal")).toThrow(/symlink/);
		} finally { rmSync(destination, { recursive: true, force: true }); }
	});

	it.each(["traversal", "foreign-builder", "foreign-source", "foreign-design"] as const)("refuses %s paths even when hashes are unchanged", (attack) => {
		let origin = applied(loadCandidateRecord(fixture.runsRoot, candidateId));
		let kind: CandidateArtifactKind = "proposal";
		if (attack === "traversal") origin = { ...origin, proposal: { ...origin.proposal, path: `builders/../${origin.proposal.path}` } };
		if (attack === "foreign-builder") origin = { ...origin, proposal: { ...origin.proposal, path: "builders/other-builder/proposal.json" } };
		if (attack === "foreign-source") { kind = "sourceEval"; origin = { ...origin, source: { ...origin.source!, evalRun: { ...origin.source!.evalRun, path: "foreign-eval/eval_run.json" } } }; }
		if (attack === "foreign-design") { kind = "experimentDesign"; origin = { ...origin, experimentDesign: { ...origin.experimentDesign!, path: "improvement-designs/other.json" } }; }
		expect(() => readCandidateArtifact(fixture.runsRoot, origin, kind)).toThrow(/traversal|unexpected artifact|invalid blind/);
	});

	it("writes portable Spec provenance when verification uses a separately moved external state store", async () => {
		const destination = copyProject(fixture.projectDir);
		const external = realpathSync(mkdtempSync(join(tmpdir(), "ahde-external-state-")));
		try {
			cpSync(join(destination, ".ahde"), external, { recursive: true });
			rmSync(join(destination, ".ahde"), { recursive: true });
			const runsRoot = join(destination, "runs");
			const origin = applied(loadCandidateRecord(runsRoot, candidateId));
			const designPath = resolveCandidateArtifact(runsRoot, origin, "experimentDesign");
			const refs = improvementDesignCorpusRefs(loadImprovementExperimentDesign(designPath), external);
			const result = await runAppliedBuilderCandidate({
				repositoryDir: destination, runsRoot, projectId: fixture.projectId,
				builderRunId: origin.builderRunId, candidateId: "candidate-external-state", repetitions: 2,
				approvedSpec: { stateRoot: external, specId: fixture.approvedSpecId },
				developmentCorpus: refs.authoring, validationCorpus: refs.validation, experimentDesignPath: designPath,
			});
			const currentOrigin = applied(result.record);
			expect(currentOrigin.approvedSpec.artifact.path).toBe(`builders/${origin.builderRunId}/approved_spec.json`);
			expect(readCandidateArtifact(runsRoot, currentOrigin, "approvedSpec").bytes)
				.toEqual(readFileSync(join(external, "projects", fixture.projectId, "specs", `${fixture.approvedSpecId}.json`)));
			expect(inspectCandidateImpact({ runsRoot, stateRoot: external, candidateId: result.record.candidateId }).verdict).toBe("improved");
		} finally { rmSync(destination, { recursive: true, force: true }); rmSync(external, { recursive: true, force: true }); }
	});

	it.runIf(process.platform !== "win32")("refuses a FIFO artifact before trying to read it", () => {
		const destination = copyProject(fixture.projectDir);
		try {
			const runsRoot = join(destination, "runs");
			const origin = applied(loadCandidateRecord(runsRoot, candidateId));
			const path = resolveCandidateArtifact(runsRoot, origin, "proposal");
			rmSync(path); execFileSync("mkfifo", [path]);
			expect(() => readCandidateArtifact(runsRoot, origin, "proposal")).toThrow(/bounded regular/);
		} finally { rmSync(destination, { recursive: true, force: true }); }
	});

	it.each(["darwin-alias", "windows", "external-store"] as const)("resolves legacy %s hints from current owned stores only", (layout) => {
		const origin = applied(loadCandidateRecord(fixture.runsRoot, candidateId));
		const oldRuns = layout === "darwin-alias" ? "/private/var/old/project/runs" : "C:/old/project/runs";
		const oldState = layout === "darwin-alias" ? "/var/old/project/.ahde" : layout === "windows" ? "C:/old/project/.ahde" : "D:/external/project-state";
		const spelling = (path: string) => layout === "windows" ? path.replaceAll("/", "\\") : path;
		const legacy: AppliedCandidateOrigin = {
			...origin,
			builderRun: { ...origin.builderRun, path: spelling(`${oldRuns}/${origin.builderRun.path}`) },
			approvedSpec: { ...origin.approvedSpec, artifact: { ...origin.approvedSpec.artifact,
				path: spelling(`${oldState}/projects/${fixture.projectId}/specs/${fixture.approvedSpecId}.json`) } },
		};
		if (layout === "external-store") {
			expect(() => readCandidateArtifact(fixture.runsRoot, legacy, "approvedSpec")).toThrow(/explicit stateRoot/);
		}
		const options = layout === "external-store" ? { stateRoot: fixture.stateRoot } : {};
		expect(readCandidateArtifact(fixture.runsRoot, legacy, "approvedSpec", options).bytes)
			.toEqual(readCandidateArtifact(fixture.runsRoot, origin, "approvedSpec").bytes);
	});

	it("reads the historical absolute encoding of a real evaluated candidate after copying, without modifying its stored bytes/hash", async () => {
		const historical = copyProject(fixture.projectDir);
		const oldRuns = join(historical, "runs");
		const oldState = join(historical, ".ahde");
		const source = loadCandidateRecord(oldRuns, candidateId);
		const sourceOrigin = applied(source);
		const absolute = (kind: CandidateArtifactKind) => ({ ...candidateArtifactReference(sourceOrigin, kind), path: join(oldRuns, candidateArtifactReference(sourceOrigin, kind).path) });
		// Reproduce the old writer's encoding using actual measured evidence,
		// before taking the immutable original-byte snapshot under test.
		const legacyOrigin: AppliedCandidateOrigin = {
			...sourceOrigin, builderRun: absolute("builderRun"), builderInput: absolute("builderInput"),
			proposal: absolute("proposal"), applyReceipt: absolute("applyReceipt"),
			source: { ...sourceOrigin.source!, evalRun: absolute("sourceEval"), diagnosis: absolute("sourceDiagnosis") },
			experimentDesign: absolute("experimentDesign"),
			approvedSpec: { ...sourceOrigin.approvedSpec, artifact: { ...sourceOrigin.approvedSpec.artifact,
				path: join(oldState, "projects", fixture.projectId, "specs", `${fixture.approvedSpecId}.json`) } },
		};
		writeFileSync(candidateRecordPath(oldRuns, candidateId), `${JSON.stringify({ ...source, origin: legacyOrigin })}\n`);
		const original = loadCandidateRecord(oldRuns, candidateId);
		const before = readFileSync(candidateRecordPath(oldRuns, candidateId));
		const destination = copyProject(historical);
		try {
			const current = { projectDir: destination, runsRoot: join(destination, "runs"), stateRoot: join(destination, ".ahde"), projectId: fixture.projectId };
			for (const kind of KINDS) writeFileSync(resolveCandidateArtifact(oldRuns, legacyOrigin, kind, { stateRoot: oldState }), "POISONED LEGACY COPY");
			const record = loadCandidateRecord(current.runsRoot, candidateId);
			expect(hashValue(record)).toBe(hashValue(original));
			// No explicit stateRoot is needed for the historical sibling .ahde/runs layout.
			expect(inspectCandidateImpact({ runsRoot: current.runsRoot, candidateId }).verdict).toBe("improved");
			expect(candidateProposalReview(current.runsRoot, record)?.proposalHash).toBe(legacyOrigin.proposal.sha256);
			const view = await createAhdeWorkbench(current).view({ aspect: "review" });
			expect(view.selections.some((entry) => entry.kind === "candidate" && entry.id === candidateId)).toBe(true);
			expect(readFileSync(candidateRecordPath(current.runsRoot, candidateId))).toEqual(before);
			expect(readFileSync(candidateRecordPath(oldRuns, candidateId))).toEqual(before);
			// An explicit current state store is authoritative; never fall back to the historical hint.
			const emptyState = join(destination, "empty-state"); mkdirSync(emptyState);
			expect(() => readCandidateArtifact(current.runsRoot, legacyOrigin, "approvedSpec", { stateRoot: emptyState })).toThrow(/ENOENT/);
		} finally { rmSync(destination, { recursive: true, force: true }); rmSync(historical, { recursive: true, force: true }); }
	});
});
