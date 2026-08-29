import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface FixtureFile {
	path: string;
	content: string;
}

export function makeTargetFixture(files: FixtureFile[], useRealGit = true): string {
	const dir = join(tmpdir(), `ahde-fixture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(dir, { recursive: true });
	for (const file of files) {
		const path = join(dir, file.path);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, file.content);
	}
	if (useRealGit) {
		execFileSync("git", ["-C", dir, "init", "-q"]);
		execFileSync("git", ["-C", dir, "add", "."]);
		execFileSync("git", ["-C", dir, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "fixture"]);
	}
	// The Workbench canonicalizes its roots (macOS /var → /private/var); hand
	// tests the same spelling so path expectations stay exact.
	return realpathSync(dir);
}

export function cleanup(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

export function readJson(dir: string, rel: string): unknown {
	return JSON.parse(readFileSync(join(dir, rel), "utf8"));
}

export const AGENTS_MD = `# Test Agent

Ты тестовый агент. Отвечай кратко.
`;

export const NARROW_SKILL_MD = `---
name: check-dbo
description: Проверка ограничений ДБО для премиальных клиентов.
---

Проверь ограничения через bin/check_dbo.
`;

export const DATASET_2TASKS = [
	JSON.stringify({
		id: "task_001",
		input: "Проверь договор 42 и ограничения ДБО.",
		graders: [
			{ type: "tool_called", tool: "bash", argsContains: "check_dbo" },
			{ type: "output_contains", text: "договор" },
		],
	}),
	JSON.stringify({
		id: "task_002",
		input: "Классифицируй обращение: жалоба на списание.",
		graders: [{ type: "output_contains", text: "жалоба" }],
	}),
].join("\n");

export function baseFixtureFiles(overrides: Record<string, string> = {}): FixtureFile[] {
	const files: FixtureFile[] = [
		{
			path: "manifest.yaml",
			content: `id: test-target
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
`,
		},
		{ path: "AGENTS.md", content: AGENTS_MD },
		{ path: "skills/check-dbo/SKILL.md", content: NARROW_SKILL_MD },
		{ path: "evals/development.jsonl", content: DATASET_2TASKS },
		{ path: "evals/graders.yaml", content: "defaults: []\n" },
		{ path: "bin/check_dbo", content: "#!/usr/bin/env bash\necho 'dbo-ok'\n" },
	];
	for (const [path, content] of Object.entries(overrides)) {
		const idx = files.findIndex((f) => f.path === path);
		if (idx >= 0) files[idx] = { path, content };
		else files.push({ path, content });
	}
	return files;
}
