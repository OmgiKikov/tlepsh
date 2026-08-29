import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { graderName, loadTarget, scaffoldTarget } from "../src/manifest.js";
import { AGENTS_MD, baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

describe("loadTarget", () => {
	it("resolves a valid target: manifest, tasks, hashes, runtime info", () => {
		const dir = makeTargetFixture(baseFixtureFiles());
		try {
			const target = loadTarget(dir);
			expect(target.manifest.id).toBe("test-target");
			expect(target.tasks).toHaveLength(2);
			expect(target.tasks[0]?.effectiveGraders).toHaveLength(2);
			expect(target.tasks[1]?.effectiveGraders).toHaveLength(1);
			expect(target.gitSha).toMatch(/^[0-9a-f]{40}$/);
			expect(target.runtime.piVersion).toBe("0.84.3");
			expect(target.runtime.piSha).toMatch(/^[0-9a-f]{40}$/);
			expect(target.runtime.ahdeVersion).toBe("0.1.0");
			expect(target.runtime.ahdeCodeHash).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(target.datasetHash).toMatch(/^sha256:/);
			expect(target.suiteHash).toMatch(/^sha256:/);
		} finally {
			cleanup(dir);
		}
	});

	it("applies suite grader defaults to tasks without own graders", () => {
		const dir = makeTargetFixture(
			baseFixtureFiles({
				"evals/development.jsonl": `${JSON.stringify({ id: "task_001", input: "x" })}\n`,
				"evals/graders.yaml": `defaults:\n  - type: output_contains\n    text: "ok"\n`,
			}),
		);
		try {
			const target = loadTarget(dir);
			expect(target.tasks[0]?.effectiveGraders).toEqual([
				{ type: "output_contains", text: "ok", caseSensitive: false },
			]);
		} finally {
			cleanup(dir);
		}
	});

	it("rejects a task with no graders anywhere", () => {
		const dir = makeTargetFixture(
			baseFixtureFiles({
				"evals/development.jsonl": `${JSON.stringify({ id: "task_001", input: "x" })}\n`,
				"evals/graders.yaml": "defaults: []\n",
			}),
		);
		try {
			expect(() => loadTarget(dir)).toThrow(/task_001: no graders/);
		} finally {
			cleanup(dir);
		}
	});

	it("rejects unknown manifest fields (strict schema)", () => {
		const dir = makeTargetFixture(
			baseFixtureFiles({
				"manifest.yaml": `id: test-target\nmodel:\n  provider: p\n  id: m\n  api: openai-completions\n  baseUrl: http://x/v1\n  apiKeyEnv: K\n  thinkingLevel: "off"\n  timeoutMs: 1000\ninstructions:\n  agentsMd: AGENTS.md\nskills: []\nevalSuite:\n  id: s\n  dataset: evals/development.jsonl\n  graders: evals/graders.yaml\npolicies: {}\n`,
			}),
		);
		try {
			expect(() => loadTarget(dir)).toThrow(/manifest\.yaml/);
		} finally {
			cleanup(dir);
		}
	});

	it("rejects missing files with precise errors", () => {
		const files = baseFixtureFiles().filter((f) => f.path !== "AGENTS.md");
		const dir = makeTargetFixture(files);
		try {
			expect(() => loadTarget(dir)).toThrow();
		} finally {
			cleanup(dir);
		}
	});

	it("rejects duplicate task ids", () => {
		const line = JSON.stringify({ id: "task_001", input: "x" });
		const dir = makeTargetFixture(
			baseFixtureFiles({ "evals/development.jsonl": `${line}\n${line}\n` }),
		);
		try {
			expect(() => loadTarget(dir)).toThrow(/duplicate task ids/);
		} finally {
			cleanup(dir);
		}
	});

	it("includes uncommitted target changes in git identity", () => {
		const dir = makeTargetFixture(baseFixtureFiles());
		try {
			const clean = loadTarget(dir);
			expect(clean.gitSha).toMatch(/^[0-9a-f]{40}$/);
			writeFileSync(`${dir}/AGENTS.md`, `${AGENTS_MD}\nDirty change\n`);
			const dirty = loadTarget(dir);
			expect(dirty.gitSha).toMatch(/^[0-9a-f]{40}-dirty-[0-9a-f]{12}$/);
			expect(dirty.gitSha).not.toBe(clean.gitSha);
		} finally {
			cleanup(dir);
		}
	});

	it("suiteHash changes when grader defaults change, datasetHash does not", () => {
		const dirA = makeTargetFixture(baseFixtureFiles());
		const dirB = makeTargetFixture(
			baseFixtureFiles({
				"evals/graders.yaml": `defaults:\n  - type: output_contains\n    text: "other"\n`,
			}),
		);
		try {
			const a = loadTarget(dirA);
			const b = loadTarget(dirB);
			expect(a.datasetHash).toBe(b.datasetHash);
			expect(a.suiteHash).not.toBe(b.suiteHash);
		} finally {
			cleanup(dirA);
			cleanup(dirB);
		}
	});
	it("rejects judge graders when evalSuite.judge is not configured", () => {
		const dir = makeTargetFixture(
			baseFixtureFiles({
				"evals/development.jsonl": `${JSON.stringify({
					id: "task_001",
					input: "x",
					graders: [{ type: "judge", rubric: "ответ по существу" }],
				})}\n`,
			}),
		);
		try {
			expect(() => loadTarget(dir)).toThrow(/judge/);
		} finally {
			cleanup(dir);
		}
	});

	it("hashes a dataset without the optional case fields exactly as it always did", () => {
		const dir = makeTargetFixture(baseFixtureFiles());
		try {
			const target = loadTarget(dir);
			expect(target.datasetHash).toBe("sha256:66fb1c48a43a21da97f828c7194c8e3eb4d767753b038a204d4ed360eab8a8fc");
			expect(target.suiteHash).toBe("sha256:1da953c85efa348d5b684d598d71b9c013c47912e221d8e2a80d424dd2188427");
		} finally {
			cleanup(dir);
		}
	});

	it("loads reference answers, dialogue history and metadata, and scores them", () => {
		const plain = JSON.stringify({ id: "task_001", input: "И для золотых клиентов?", graders: [{ type: "output_contains", text: "60" }] });
		const rich = JSON.stringify({
			id: "task_001",
			input: "И для золотых клиентов?",
			expected: "Для золотых клиентов — 60 дней.",
			messages: [
				{ role: "user", content: "Сколько длится возврат?" },
				{ role: "assistant", content: "Тридцать дней." },
				{ role: "user", content: "И для золотых клиентов?" },
			],
			metadata: { tier: "gold" },
			graders: [{ type: "output_contains", text: "60" }],
		});
		const plainDir = makeTargetFixture(baseFixtureFiles({ "evals/development.jsonl": `${plain}\n` }));
		const richDir = makeTargetFixture(baseFixtureFiles({ "evals/development.jsonl": `${rich}\n` }));
		try {
			const target = loadTarget(richDir);
			expect(target.tasks[0]?.expected).toBe("Для золотых клиентов — 60 дней.");
			expect(target.tasks[0]?.messages).toHaveLength(3);
			expect(target.tasks[0]?.metadata).toEqual({ tier: "gold" });
			expect(target.datasetHash).not.toBe(loadTarget(plainDir).datasetHash);
		} finally {
			cleanup(plainDir);
			cleanup(richDir);
		}
	});

	it("rejects a dialogue whose last turn is not the user turn in input", () => {
		const dir = makeTargetFixture(
			baseFixtureFiles({
				"evals/development.jsonl": `${JSON.stringify({
					id: "task_001",
					input: "x",
					messages: [{ role: "user", content: "x" }, { role: "assistant", content: "y" }],
					graders: [{ type: "output_contains", text: "ok" }],
				})}\n`,
			}),
		);
		try {
			expect(() => loadTarget(dir)).toThrow(/line 1: the last message must be the user turn/);
		} finally {
			cleanup(dir);
		}
	});

	it("dataset override swaps tasks and changes datasetHash (dev/holdout split)", () => {
		const dir = makeTargetFixture(
			baseFixtureFiles({
				"evals/holdout.jsonl": `${JSON.stringify({ id: "task_holdout", input: "holdout input", graders: [{ type: "output_contains", text: "ok" }] })}\n`,
			}),
		);
		try {
			const dev = loadTarget(dir);
			const holdout = loadTarget(dir, { dataset: "evals/holdout.jsonl" });
			expect(holdout.tasks.map((t) => t.id)).toEqual(["task_holdout"]);
			expect(holdout.manifest.evalSuite.dataset).toBe("evals/holdout.jsonl");
			expect(holdout.datasetHash).not.toBe(dev.datasetHash);
			expect(holdout.suiteHash).not.toBe(dev.suiteHash);
		} finally {
			cleanup(dir);
		}
	});

	it("rejects manifest and dataset-override paths that escape the target repository", () => {
		const dir = makeTargetFixture(baseFixtureFiles());
		const outside = join(dir, "..", `ahde-outside-${Date.now()}.jsonl`);
		writeFileSync(outside, `${JSON.stringify({ id: "secret", input: "secret", graders: [] })}\n`);
		try {
			expect(() => loadTarget(dir, { dataset: `../${outside.split("/").pop()}` })).toThrow(
				/target path escapes repository/,
			);
		} finally {
			cleanup(dir);
			rmSync(outside, { force: true });
		}
	});
});

describe("scaffoldTarget", () => {
	it("copies the template into a fresh valid target (init → validate passes immediately)", () => {
		const template = makeTargetFixture(baseFixtureFiles());
		const dest = join(tmpdir(), `ahde-init-${Date.now()}`);
		try {
			scaffoldTarget(template, dest);
			const target = loadTarget(dest);
			expect(target.manifest.id).toBe("test-target");
			expect(target.gitSha).toMatch(/^[0-9a-f]{40}$/);
		} finally {
			cleanup(template);
			cleanup(dest);
		}
	});

	it("ignores AHDE-local state and secrets while preserving custom template ignores", () => {
		const template = makeTargetFixture(baseFixtureFiles({ ".gitignore": "/custom-cache/\n" }));
		const dest = join(tmpdir(), `ahde-init-local-state-${Date.now()}`);
		try {
			scaffoldTarget(template, dest);
			const cleanSha = loadTarget(dest).gitSha;
			expect(readFileSync(join(dest, ".gitignore"), "utf8")).toBe(
				"/custom-cache/\n\n# AHDE local state, Builder imports, run evidence, and secrets\n" +
					"/.ahde/\n/imports/\n/runs/\n/.env\n/.env.*\n!/.env.example\n",
			);

			mkdirSync(join(dest, ".ahde", "projects", "test-target"), { recursive: true });
			mkdirSync(join(dest, "imports"), { recursive: true });
			mkdirSync(join(dest, "runs", "eval-1"), { recursive: true });
			writeFileSync(join(dest, ".ahde", "projects", "test-target", "state.json"), "{}\n");
			writeFileSync(join(dest, "imports", "examples.jsonl"), "PRIVATE_BUILDER_EXAMPLE\n");
			writeFileSync(join(dest, "runs", "eval-1", "eval_run.json"), "{}\n");
			writeFileSync(join(dest, ".env"), "TEST_MODEL_KEY=secret\n");
			writeFileSync(join(dest, ".env.local"), "TEST_MODEL_KEY=local-secret\n");
			expect(loadTarget(dest).gitSha).toBe(cleanSha);

			writeFileSync(join(dest, ".env.example"), "TEST_MODEL_KEY=replace-me\n");
			expect(loadTarget(dest).gitSha).toMatch(/^[0-9a-f]{40}-dirty-[0-9a-f]{12}$/);
		} finally {
			cleanup(template);
			cleanup(dest);
		}
	});

	it("refuses an existing destination", () => {
		const template = makeTargetFixture(baseFixtureFiles());
		const dest = makeTargetFixture(baseFixtureFiles());
		try {
			expect(() => scaffoldTarget(template, dest)).toThrow(/already exists/);
		} finally {
			cleanup(template);
			cleanup(dest);
		}
	});
});

describe("graderName", () => {
	it("uses explicit name when present", () => {
		expect(
			graderName({ type: "output_contains", text: "x", caseSensitive: false, name: "my-check" }, { id: "t" }, 0),
		).toBe("my-check");
	});

	it("builds a descriptive default name", () => {
		expect(graderName({ type: "tool_called", tool: "bash", argsContains: "check_dbo" }, { id: "t1" }, 0)).toBe(
			"t1#0:tool_called:bash(check_dbo)",
		);
	});
});
