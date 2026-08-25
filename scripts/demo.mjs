#!/usr/bin/env node
// Живая демонстрация полного цикла платформы (mock-модель, ноль токенов):
//   baseline → failure bundle → builder патчит skill → candidate → compare → promote
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockModel } from "../dist/mock-model.js";
import { loadTarget } from "../dist/manifest.js";
import { runSuite } from "../dist/eval.js";
import { compileFailureBundle } from "../dist/bundle.js";
import { runBuilder } from "../dist/builder.js";
import { runCandidateFlow, promote } from "../dist/loop.js";
import { renderCompareMarkdown } from "../dist/compare.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const step = (title) => console.log(`\n\x1b[1m=== ${title} ===\x1b[0m`);

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

const mock = await startMockModel([
	{
		// Judge grader (task_004): вердикт по rubric.
		match: ({ system }) => system.includes("грейдер"),
		steps: [{ text: '{"passed": true, "reason": "классификация и ответ по существу верны"}' }],
	},
	{
		match: ({ firstUser }) => firstUser.includes("инженер"),
		steps: [
			{ toolCall: { name: "read", arguments: { path: "__BUNDLE__" } } },
			{
				toolCall: {
					name: "bash",
					arguments: {
						command: `git checkout -b candidate-demo && cat > skills/check-dbo/SKILL.md <<'SKILL_EOF'\n${WIDE_SKILL}SKILL_EOF\ngit add -A && git commit -qm "improve: widen check-dbo skill description"`,
					},
				},
			},
			{ text: "Расширил описание скилла check-dbo: failures показывают, что агент не вызывает проверку ДБО." },
		],
	},
	{ match: ({ firstUser }) => firstUser.includes("классифицируй"), steps: [{ text: "Категория обращения: жалоба." }] },
	{ match: ({ firstUser }) => firstUser.includes("вопрос"), steps: [{ text: "Тип обращения: вопрос." }] },
	{
		match: ({ system, firstUser }) => !system.includes("для любых обращений") && firstUser.includes("договор"),
		steps: [{ text: "Договор действующий. Ограничений не найдено." }],
	},
	{
		match: ({ system, firstUser }) => system.includes("для любых обращений") && firstUser.includes("договор"),
		steps: [
			{ toolCall: { name: "bash", arguments: { command: "bin/check_dbo --client 42" } } },
			{ text: "Договор действующий. Ограничения ДБО: не найдены." },
		],
	},
]);

const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "ahde-demo-"));
process.env.AHDE_EVOLUTION_LOG = join(root, "evolution.jsonl"); // demo не трогает repo-лог
const targetDir = join(root, "ombudsman");
const builderDir = join(root, "builder");
const runsRoot = join(root, "runs");
cpSync(join(REPO, "targets", "ombudsman"), targetDir, { recursive: true });
cpSync(join(REPO, "builders", "default"), builderDir, { recursive: true });
for (const dir of [targetDir, builderDir]) {
	execFileSync("git", ["-C", dir, "init", "-q"]);
	const manifestPath = join(dir, "manifest.yaml");
	// Demo isolation: подменяем и endpoint, и имя ключа — прогон не зависит
	// от реального OPENROUTER_API_KEY и не трогает .env пользователя.
	const manifest = readFileSync(manifestPath, "utf8")
		.replace(/baseUrl: .*/g, `baseUrl: ${mock.url}`)
		.replace(/apiKeyEnv: .*/g, "apiKeyEnv: AHDE_DEMO_KEY");
	writeFileSync(manifestPath, manifest);
	execFileSync("git", ["-C", dir, "add", "-A"]);
	execFileSync("git", ["-C", dir, "-c", "user.name=demo", "-c", "user.email=demo@demo", "commit", "-qm", "demo"]);
}
process.env.AHDE_DEMO_KEY = "demo";

try {
	step("1. TARGET: ombudsman (model from its manifest + узкий skill description — заложенный failure)");
	const target = loadTarget(targetDir);
	console.log(`    ${target.tasks.length} задач, suite ${target.suiteHash.slice(7, 19)}…, harness ${target.gitSha.slice(0, 8)}`);

	step("2. RUN: baseline прогон всей suite");
	const baseline = await runSuite(target, { runsRoot, label: "baseline", repetitions: 1 });
	console.log(`    eval run ${baseline.evalRunId}: ${baseline.summary.pass}/${baseline.summary.total} all-pass (${baseline.summary.fail} fail)`);

	step("3. FAILURES: компиляция failure bundle");
	const bundlePath = compileFailureBundle(target, baseline, runsRoot);
	console.log(`    ${bundlePath}`);
	console.log(`    (failed tasks: ${baseline.summary.fail}, в bundle: трейсы, grader-причины, AGENTS.md, SKILL.md)`);

	step("4. IMPROVE: Builder работает на том же model runtime, что и target, читает bundle и патчит harness на ветке");
	const builder = await runBuilder(builderDir, target, bundlePath, { runsRoot, branch: "candidate-demo" });
	console.log(`    builder run ${builder.builderRunId} → ветка ${builder.branch} (${builder.commitSha.slice(0, 8)})`);
	for (const file of builder.changedFiles) console.log(`    изменён: ${file}`);

	step("5. VERIFY: candidate flow — validate → smoke → suite → compare vs baseline");
	const flow = await runCandidateFlow({ runsRoot, targetDir, branch: "candidate-demo" });
	console.log(renderCompareMarkdown(flow.compare).replace(/^/gm, "    "));

	step("6. DECIDE: promote (git tag + evolution log) — human gate");
	const promotion = promote({ targetDir, evalRunId: flow.candidate.evalRunId, version: "0.2.0", runsRoot });
	console.log(`    ${promotion.tag} на коммите ${flow.candidate.target.gitSha.slice(0, 8)} (${promotion.changedFiles.length} файл(ов))`);
	console.log(`\n\x1b[32mЦикл замкнут: harness 0.1.0 → 0.2.0, доказано eval-сравнением.\x1b[0m`);
	console.log(`Артефакты: ${root}`);
} finally {
	await mock.close();
	rmSync(root, { recursive: true, force: true });
}
