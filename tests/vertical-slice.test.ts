import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileFailureBundle } from "../src/bundle.js";
import { runBuilder } from "../src/builder.js";
import { runSuite } from "../src/eval.js";
import { runCandidateFlow, promote } from "../src/loop.js";
import { loadTarget } from "../src/manifest.js";
import { startMockModel, type MockModelHandle } from "../src/mock-model.js";

/**
 * THE VERTICAL SLICE — the full improvement cycle with zero real tokens:
 *
 *   baseline (2/5) → failure bundle → builder patches skill on a branch
 *   → candidate flow (validate/smoke/suite/compare) → 5/5 → promote (git tag)
 *
 * The mock target model is scripted, but context-routed: with the narrow
 * skill description it never calls check_dbo; with the widened one it does.
 * The skill patch therefore flows through the real pipeline (git → eval →
 * compare → promote) — exactly the platform's thesis.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CANDIDATE_BRANCH = "candidate-demo-1";

let mock: MockModelHandle;
let targetDir: string;
let builderDir: string;
let runsRoot: string;
let evolutionLog: string;

const WIDE_SKILL = `---
name: check-dbo
description: Проверка ограничений ДБО для любых обращений, где упоминаются договоры или списания.
---

Для проверки ограничений ДБО запусти:

\`\`\`bash
bin/check_dbo --client <id>
\`\`\`

и укажи найденные ограничения в ответе.
`;

function copyTemplate(srcDir: string, destDir: string, baseUrl: string): void {
	mkdirSync(destDir, { recursive: true });
	execFileSync("cp", ["-R", `${srcDir}/.`, destDir]);
	const manifestPath = join(destDir, "manifest.yaml");
	// Test isolation: подменяем endpoint и имя ключа — прогон не зависит
	// от реального OPENROUTER_API_KEY из .env.
	const manifest = readFileSync(manifestPath, "utf8")
		.replace(/baseUrl: .*/g, `baseUrl: ${baseUrl}`)
		.replace(/apiKeyEnv: .*/g, "apiKeyEnv: AHDE_TEST_KEY");
	writeFileSync(manifestPath, manifest);
	execFileSync("git", ["-C", destDir, "init", "-q"]);
	execFileSync("git", ["-C", destDir, "add", "."]);
	execFileSync("git", ["-C", destDir, "-c", "user.name=demo", "-c", "user.email=demo@demo", "commit", "-qm", "initial"]);
}

beforeAll(async () => {
	mock = await startMockModel([
		{
			// Judge grader for task_004: verdict on the (correct) canned answer.
			match: ({ system }) => system.includes("грейдер"),
			steps: [{ text: '{"passed": true, "reason": "классификация и ответ по существу верны"}' }],
		},
		{
			// Builder: reads the bundle, patches the skill on a branch, reports.
			match: ({ firstUser }) => firstUser.includes("инженер"),
			steps: [
				{ toolCall: { name: "read", arguments: { path: "__BUNDLE_PATH__" } } },
				{
					toolCall: {
						name: "bash",
						arguments: {
							command: `git checkout -b ${CANDIDATE_BRANCH} && cat > skills/check-dbo/SKILL.md <<'SKILL_EOF'\n${WIDE_SKILL}SKILL_EOF\ngit add -A && git commit -qm "improve: widen check-dbo skill description"`,
						},
					},
				},
				{ text: "Проанализировал failure bundle: в 3 failed runs агент не вызывал check_dbo — описание скилла слишком узкое. Расширил description, чтобы скилл срабатывал для любых обращений с договорами." },
			],
		},
		{
			match: ({ firstUser }) => firstUser.includes("классифицируй"),
			steps: [{ text: "Категория обращения: жалоба." }],
		},
		{
			match: ({ firstUser }) => firstUser.includes("вопрос"),
			steps: [{ text: "Тип обращения: вопрос. Комиссия за перевод между своими счетами не взимается." }],
		},
		{
			// Narrow skill: answers directly, never calls check_dbo.
			match: ({ system, firstUser }) => !system.includes("для любых обращений") && firstUser.includes("договор"),
			steps: [{ text: "Договор действующий. Ограничений не найдено." }],
		},
		{
			// Widened skill: follows it, calls check_dbo through bash.
			match: ({ system, firstUser }) => system.includes("для любых обращений") && firstUser.includes("договор"),
			steps: [
				{ toolCall: { name: "bash", arguments: { command: "bin/check_dbo --client 42" } } },
				{ text: "Договор действующий. Ограничения ДБО: не найдены." },
			],
		},
	]);

	const root = join(tmpdir(), `ahde-slice-${Date.now()}`);
	targetDir = join(root, "ombudsman");
	builderDir = join(root, "builder");
	runsRoot = join(root, "runs");
	evolutionLog = join(root, "evolution.jsonl");
	copyTemplate(join(REPO_ROOT, "targets", "ombudsman"), targetDir, mock.url);
	copyTemplate(join(REPO_ROOT, "builders", "default"), builderDir, mock.url);
	process.env.AHDE_TEST_KEY = "test";
	process.env.AHDE_EVOLUTION_LOG = evolutionLog;
});

afterAll(() => {
	rmSync(join(targetDir, ".."), { recursive: true, force: true });
	void mock.close();
	delete process.env.AHDE_EVOLUTION_LOG;
});

describe("vertical slice: full improvement cycle", () => {
	it("baseline → bundle → builder patch → candidate → compare → promote", async () => {
		// 1. Baseline: 3 of 5 tasks fail (no check_dbo calls).
		const target = loadTarget(targetDir);
		const baseline = await runSuite(target, { runsRoot, label: "baseline", repetitions: 1 });
		expect(baseline.summary.pass).toBe(2);
		expect(baseline.summary.fail).toBe(3);
		expect(baseline.summary.error).toBe(0);

		// 2. Failure bundle: self-contained markdown for the builder.
		const bundlePath = compileFailureBundle(target, baseline, runsRoot);
		const bundle = readFileSync(bundlePath, "utf8");
		expect(bundle).toContain("Failure Bundle — ombudsman");
		expect(bundle).toContain("Allowed change scope");
		expect(bundle).toContain("never called bash");
		expect(bundle).toContain("skills/check-dbo/SKILL.md");
		expect(bundle).toContain("### Execution trace");
		expect((bundle.match(/## Failed task/g) ?? []).length).toBe(3);

		// 3. Builder patches the target repo on a branch (own run = evidence).
		const builder = await runBuilder(builderDir, target, bundlePath, {
			runsRoot,
			branch: CANDIDATE_BRANCH,
		});
		expect(builder.changedFiles).toContain("skills/check-dbo/SKILL.md");
		expect(existsSync(join(runsRoot, builder.builderRunId, "session.jsonl"))).toBe(true);
		const builderSkill = readFileSync(join(targetDir, "skills/check-dbo/SKILL.md"), "utf8");
		expect(builderSkill).toContain("для любых обращений");

		// 4. Candidate flow: validate → smoke → suite → baseline reuse → compare.
		const flow = await runCandidateFlow({ runsRoot, targetDir, branch: CANDIDATE_BRANCH });
		expect(flow.baseline?.evalRunId).toBe(baseline.evalRunId); // reused, not re-run
		expect(flow.candidate.summary.pass).toBe(5);
		expect(flow.candidate.summary.fail).toBe(0);
		expect(flow.compare.error).toBeNull();
		const improved = flow.compare.rows.filter((r) => r.delta > 0);
		const regressed = flow.compare.rows.filter((r) => r.delta < 0);
		expect(improved.length).toBe(3);
		expect(regressed.length).toBe(0);

		// 5. Promote: git tag + evolution log, human-gated command.
		const promotion = promote({
			targetDir,
			evalRunId: flow.candidate.evalRunId,
			version: "0.2.0",
			runsRoot,
		});
		expect(promotion.tag).toBe("v0.2.0");
		const tags = execFileSync("git", ["-C", targetDir, "tag", "--list"], { encoding: "utf8" });
		expect(tags).toContain("v0.2.0");
		const tagMessage = execFileSync("git", ["-C", targetDir, "tag", "-l", "--format=%(contents)", "v0.2.0"], {
			encoding: "utf8",
		});
		expect(tagMessage).toContain(flow.candidate.evalRunId);
		expect(existsSync(evolutionLog)).toBe(true);
		const logLine = readFileSync(evolutionLog, "utf8").trim();
		expect(JSON.parse(logLine)).toMatchObject({ action: "promote", version: "0.2.0" });
	}, 300_000);

	it("promote refuses scope violations (evals/ changes)", async () => {
		// Reuse the promoted state: create a candidate that touches evals/.
		execFileSync("git", ["-C", targetDir, "checkout", "-q", "-b", "evil-candidate"]);
		execFileSync("bash", ["-c", `cd ${targetDir} && echo '' >> evals/development.jsonl && git add -A && git -c user.name=e -c user.email=e@e commit -qm "touch evals"`]);
		const target = loadTarget(targetDir);
		const evilRun = await runSuite(target, { runsRoot, label: "candidate", repetitions: 1 });
		// link the original baseline via provenance match
		const { loadEvalRun, listEvalRuns } = await import("../src/eval.js");
		const evilRecord = loadEvalRun(runsRoot, evilRun.evalRunId);
		const baseline = listEvalRuns(runsRoot).find(
			(r) => r.label === "baseline" && r.provenanceKey === evilRecord.provenanceKey,
		);
		evilRecord.baselineEvalRunId = baseline?.evalRunId ?? null;
		require("node:fs").writeFileSync(join(runsRoot, evilRun.evalRunId, "eval_run.json"), JSON.stringify(evilRecord, null, "\t"));

		expect(() =>
			promote({ targetDir, evalRunId: evilRun.evalRunId, version: "0.3.0", runsRoot }),
		).toThrow(/scope violation.*evals/);
	}, 120_000);
});
