import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectAgentFolder, MAX_SCANNED_FILES } from "../src/application/agent-folder-detect.js";

/**
 * The read-only guess that turns "this folder is not empty, go away" into
 * "I see an agent here — shall I adopt it?". It is allowed to be wrong; it is
 * not allowed to execute anything, to be slow, or to claim a folder that
 * already is a Target.
 */

const roots: string[] = [];

function folder(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "ahde-detect-"));
	roots.push(dir);
	for (const [path, content] of Object.entries(files)) {
		const absolute = join(dir, path);
		mkdirSync(join(absolute, ".."), { recursive: true });
		writeFileSync(absolute, content, "utf8");
	}
	return dir;
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("what counts as an agent folder", () => {
	it("names the conventional entry point and counts the tool-ish things beside it", () => {
		const dir = folder({
			"agent.py": "import openai\n\n@tool\ndef lookup(): ...\n\n@tool\ndef ticket(): ...\n",
			"README.md": "# my agent\n",
		});
		expect(detectAgentFolder(dir)).toEqual({
			entry: "agent.py",
			language: "python",
			toolCount: 2,
			filesScanned: 2,
		});
	});

	it("prefers agent.py over main.py, and main.py over app.py", () => {
		const both = folder({ "app.py": "x = 1\n", "main.py": "y = 2\n", "agent.py": "z = 3\n" });
		expect(detectAgentFolder(both)?.entry).toBe("agent.py");
		const without = folder({ "app.py": "x = 1\n", "main.py": "y = 2\n" });
		expect(detectAgentFolder(without)?.entry).toBe("main.py");
	});

	it("finds src/agent.py when the root holds nothing conventional", () => {
		const dir = folder({ "src/agent.py": "import anthropic\n", "pyproject.toml": "[project]\n" });
		expect(detectAgentFolder(dir)?.entry).toBe("src/agent.py");
	});

	it("falls back to exactly one top-level file that reaches for a model", () => {
		const one = folder({ "bot.py": "import httpx\n", "util.py": "def helper(): ...\n" });
		expect(detectAgentFolder(one)?.entry).toBe("bot.py");
		// Two candidates is a guess, and a wrong guess writes the wrong argv.
		const two = folder({ "bot.py": "import httpx\n", "worker.py": "import requests\n" });
		expect(detectAgentFolder(two)).toBeNull();
		// A Python file that talks to nothing is not an agent.
		const none = folder({ "util.py": "def helper(): ...\n" });
		expect(detectAgentFolder(none)).toBeNull();
	});

	it("counts a TOOLS literal and a tool_ prefix, not only decorators", () => {
		const dir = folder({
			"agent.py": "import openai\nTOOLS = [\n]\n\ndef tool_lookup(): ...\ndef tool_ticket(): ...\n",
		});
		expect(detectAgentFolder(dir)?.toolCount).toBe(3);
	});

	it("refuses a folder that is already a Target", () => {
		const dir = folder({ "agent.py": "import openai\n", "manifest.yaml": "id: my-agent\n" });
		expect(detectAgentFolder(dir)).toBeNull();
	});

	it("refuses a folder with no Python in it at all", () => {
		expect(detectAgentFolder(folder({ "index.ts": "export const x = 1;\n" }))).toBeNull();
	});

	it("refuses a tree too large to be one agent", () => {
		const files: Record<string, string> = { "agent.py": "import openai\n" };
		for (let index = 0; index <= MAX_SCANNED_FILES; index += 1) files[`pkg/file-${index}.txt`] = "x";
		expect(detectAgentFolder(folder(files))).toBeNull();
	});

	it("skips the directories that are never anybody's agent", () => {
		const dir = folder({
			"agent.py": "import openai\n",
			"node_modules/left-pad/index.py": "import openai\n",
			".venv/lib/thing.py": "import openai\n",
		});
		const found = detectAgentFolder(dir);
		expect(found?.entry).toBe("agent.py");
		// Only the real file was counted; the vendored trees were never walked.
		expect(found?.filesScanned).toBe(1);
	});

	it("never follows a symlink, and never throws on a folder it cannot read", () => {
		const dir = folder({ "agent.py": "import openai\n" });
		symlinkSync("/etc", join(dir, "escape"));
		expect(detectAgentFolder(dir)?.entry).toBe("agent.py");
		expect(detectAgentFolder(join(dir, "does-not-exist"))).toBeNull();
		expect(detectAgentFolder(join(dir, "agent.py"))).toBeNull();
	});
});
