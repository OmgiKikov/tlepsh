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
	/**
	 * Regression: two suite-identity formulas existed — the manifest one in
	 * `suiteHashOf` and this corpus one — and only the manifest side stripped the
	 * promotion-only calibration policy. Turning `requireCalibration` on then
	 * changed nothing about the dataset, the graders, or the judge model, yet
	 * every published-corpus eval fell out of `compatibleDevelopmentEvals`: the
	 * Workbench rewound to `ready-to-evaluate` and an in-flight candidate failed
	 * promotion with "development eval artifacts do not match". Both formulas now
	 * hash the same measurement-only view of the judge.
	 */
	it("keeps a published corpus comparable when the judge calibration policy is toggled", () => {
		const judgeBlock = `  judge:
    provider: qwen-internal
    id: judge-model
    api: openai-completions
    baseUrl: http://127.0.0.1:9901/v1
    apiKeyEnv: TEST_JUDGE_KEY
    thinkingLevel: "off"
    timeoutMs: 300000
`;
		const manifest = (calibration: string) => `id: test-target
model:
  provider: qwen-internal
  id: qwen3.5-27b
  api: openai-completions
  baseUrl: http://127.0.0.1:9901/v1
  apiKeyEnv: TEST_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: 300000
instructions:
  agentsMd: AGENTS.md
skills: [skills/check-dbo]
evalSuite:
  id: test-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
${judgeBlock}${calibration}`;
		const plainDir = makeTargetFixture(baseFixtureFiles({ "manifest.yaml": manifest("") }));
		const policyDir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": manifest("    requireCalibration:\n      minAgreement: 0.8\n      minLabels: 20\n"),
		}));
		const stateRoot = mkdtempSync(`${tmpdir()}/ahde-corpus-policy-`);
		paths.push(plainDir, policyDir, stateRoot);

		const plain = loadTarget(plainDir);
		const withPolicy = loadTarget(policyDir);
		expect(withPolicy.manifest.evalSuite.judge?.requireCalibration).toEqual({
			minAgreement: 0.8,
			minLabels: 20,
		});
		// The manifest surface was already policy-free; the corpus surface is the
		// one this test pins.
		expect(withPolicy.suiteHash).toBe(plain.suiteHash);

		const metadata = createCorpus({
			stateRoot,
			projectId: "project-1",
			name: "judged development set",
			visibility: "development",
			tasks: [{
				id: "dev-judged",
				input: "private task content",
				graders: [{ type: "judge", rubric: "The answer is on topic." }],
			}],
		});
		const corpus = loadCorpus({ stateRoot, projectId: "project-1", corpusId: metadata.id });
		const before = targetWithDevelopmentCorpus(plain, corpus);
		const after = targetWithDevelopmentCorpus(withPolicy, corpus);

		expect(after.suiteHash).toBe(before.suiteHash);
		expect(after.suiteIdentity).toBe("corpus");
		// The measurement surface is what this pins. The Target revision is a
		// separate axis and still guards a manifest edit on its own, so this
		// resolve carries the policy Target's own identity: what must not happen
		// is a *suite* mismatch on top of it.
		const resolved = resolveDevelopmentTargetForEval({
			target: withPolicy,
			stateRoot,
			projectId: "project-1",
			evalRun: {
				...source(before),
				target: { id: withPolicy.manifest.id, gitSha: withPolicy.gitSha },
			},
		});
		expect(resolved.corpus?.metadata.id).toBe(metadata.id);
		expect(targetEvalSurface(resolved.target)).toEqual(targetEvalSurface(after));
	});

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

	it("carries a published case's world, and desugars its expectations exactly as the manifest path does", () => {
		const value = fixture();
		const metadata = createCorpus({
			stateRoot: value.stateRoot,
			projectId: value.projectId,
			name: "worlded development set",
			visibility: "development",
			tasks: [{
				id: "dev-world",
				input: "заблокируй договор 42",
				world: {
					state: { accounts: { "42": { status: "ok" } } },
					expect: [{ path: "accounts.42.status", op: "equals", value: "frozen" }],
				},
				graders: [{ type: "output_contains", text: "готово" }],
			}],
		});
		const resolved = targetWithDevelopmentCorpus(
			value.target,
			loadCorpus({ stateRoot: value.stateRoot, projectId: value.projectId, corpusId: metadata.id }),
		);
		const task = resolved.tasks[0];

		// Without this the world would be dropped between corpus and run, and the
		// case would be answered in an empty world nobody declared.
		expect(task?.world?.state).toEqual({ accounts: { "42": { status: "ok" } } });
		expect(task?.graders).toEqual([{ type: "output_contains", text: "готово", caseSensitive: false }]);
		expect(task?.effectiveGraders).toEqual([
			{ type: "output_contains", text: "готово", caseSensitive: false },
			{ type: "world_state", path: "accounts.42.status", op: "equals", value: "frozen" },
		]);
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
