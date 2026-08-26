import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
	corpusDatasetLabel,
	resolveDevelopmentTargetForEval,
	targetEvalSurface,
	targetWithDevelopmentCorpus,
} from "../src/application/corpus-target.js";
import { createCorpus, loadCorpus } from "../src/corpus.js";
import { loadTarget } from "../src/manifest.js";
import { baseFixtureFiles, makeTargetFixture } from "./fixtures.js";

const paths: string[] = [];

afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
	const targetDir = makeTargetFixture(baseFixtureFiles());
	const stateRoot = mkdtempSync(`${tmpdir()}/ahde-corpus-target-`);
	paths.push(targetDir, stateRoot);
	return { target: loadTarget(targetDir), stateRoot, projectId: "project-1" };
}

function source(target: ReturnType<typeof loadTarget>) {
	return { target: { id: target.manifest.id, gitSha: target.gitSha }, ...targetEvalSurface(target) };
}

describe("canonical development corpus target", () => {
	it("keeps the manifest target only on an exact dataset/hash/suite match", () => {
		const value = fixture();
		const resolved = resolveDevelopmentTargetForEval({ ...value, evalRun: source(value.target) });

		expect(resolved.corpus).toBeNull();
		expect(resolved.target).toBe(value.target);
	});

	it("reconstructs a published development eval from its canonical label and immutable hash", () => {
		const value = fixture();
		const metadata = createCorpus({
			stateRoot: value.stateRoot,
			projectId: value.projectId,
			name: "reviewed development set",
			visibility: "development",
			tasks: [{
				id: "dev-1",
				input: "private task content",
				graders: [{ type: "output_contains", text: "ok" }],
			}],
		});
		const expected = targetWithDevelopmentCorpus(
			value.target,
			loadCorpus({ stateRoot: value.stateRoot, projectId: value.projectId, corpusId: metadata.id }),
		);
		const resolved = resolveDevelopmentTargetForEval({ ...value, evalRun: source(expected) });

		expect(resolved.corpus?.metadata).toMatchObject({ id: metadata.id, hash: metadata.hash });
		expect(targetEvalSurface(resolved.target)).toEqual(targetEvalSurface(expected));
		expect(resolved.target.manifest.evalSuite.dataset).toBe(`development-${metadata.id}.jsonl`);
	});

	it("fails closed when canonical corpus metadata is missing or has the wrong visibility", () => {
		const value = fixture();
		const sealed = createCorpus({
			stateRoot: value.stateRoot,
			projectId: value.projectId,
			name: "sealed set",
			visibility: "sealed",
			tasks: [{ id: "hidden", input: "hidden", graders: [{ type: "output_contains", text: "ok" }] }],
		});
		const evalRun = {
			target: { id: value.target.manifest.id, gitSha: value.target.gitSha },
			dataset: corpusDatasetLabel("development", sealed.id),
			datasetHash: sealed.hash,
			suiteHash: `sha256:${"a".repeat(64)}`,
		};

		expect(() => resolveDevelopmentTargetForEval({ ...value, evalRun })).toThrow(
			/cannot reconstruct the exact development evaluation surface/,
		);
	});

	it("rejects a label/hash match when the identity-bound suite hash differs", () => {
		const value = fixture();
		const metadata = createCorpus({
			stateRoot: value.stateRoot,
			projectId: value.projectId,
			name: "development set",
			visibility: "development",
			tasks: [{ id: "dev-1", input: "input", graders: [{ type: "output_contains", text: "ok" }] }],
		});
		const exact = targetWithDevelopmentCorpus(
			value.target,
			loadCorpus({ stateRoot: value.stateRoot, projectId: value.projectId, corpusId: metadata.id }),
		);
		const evalRun = { ...source(exact), suiteHash: `sha256:${"f".repeat(64)}` };

		expect(() => resolveDevelopmentTargetForEval({ ...value, evalRun })).toThrow(
			/published development corpus does not match the exact evaluation surface/,
		);
	});
});
