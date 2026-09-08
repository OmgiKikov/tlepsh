import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTarget, scaffoldTarget } from "../src/manifest.js";
import {
	disposeTargetWorkspaceSnapshot,
	materializeTargetWorkspaceSnapshot,
} from "../src/runner.js";
import { baseFixtureFiles, makeTargetFixture } from "./fixtures.js";
import {
	appendTargetFeedbackMark,
	boundTargetFeedbackDialogue,
	boundTargetFeedbackNote,
	MAX_TARGET_FEEDBACK_NOTE_CHARS,
	readTargetFeedback,
	TARGET_FEEDBACK_PATH,
	type TargetFeedbackMark,
} from "../src/application/target-feedback.js";
import { MAX_TASK_MESSAGES, MAX_TASK_TEXT_BYTES } from "../src/manifest.js";

const cleanupPaths: string[] = [];

afterEach(() => {
	for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function projectDirectory(): string {
	const dir = mkdtempSync(join(tmpdir(), "ahde-feedback-"));
	cleanupPaths.push(dir);
	return dir;
}

function mark(overrides: Partial<TargetFeedbackMark> = {}): TargetFeedbackMark {
	return {
		messages: [
			{ role: "user", content: "Проверь договор 42 и ограничения ДБО." },
			{ role: "assistant", content: "Ограничений нет." },
		],
		verdict: "bad",
		at: "2026-08-30T07:00:00.000Z",
		target: { id: "my-agent", gitSha: "0".repeat(40) },
		...overrides,
	};
}

describe("the Target feedback inbox file", () => {
	it("appends one private JSONL row per mark and counts them back", () => {
		const projectDir = projectDirectory();

		expect(appendTargetFeedbackMark(projectDir, mark())).toEqual({ path: TARGET_FEEDBACK_PATH, total: 1 });
		expect(appendTargetFeedbackMark(projectDir, mark({ verdict: "good", note: "точный ответ" })))
			.toEqual({ path: TARGET_FEEDBACK_PATH, total: 2 });

		const path = join(projectDir, TARGET_FEEDBACK_PATH);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		const rows = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as TargetFeedbackMark);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual(mark());
		expect(rows[1]?.note).toBe("точный ответ");
		// The stored keys are exactly the documented shape.
		expect(Object.keys(rows[1] ?? {}).sort()).toEqual(["at", "messages", "note", "target", "verdict"]);

		const summary = readTargetFeedback(projectDir);
		expect(summary.marks).toHaveLength(2);
		expect(summary.malformed).toBe(0);
	});

	it("counts hand-edited rows as unreadable instead of guessing at them", () => {
		const projectDir = projectDirectory();
		appendTargetFeedbackMark(projectDir, mark());
		const path = join(projectDir, TARGET_FEEDBACK_PATH);
		writeFileSync(path, `${readFileSync(path, "utf8")}not json\n{"verdict":"bad"}\n`);

		const summary = readTargetFeedback(projectDir);
		expect(summary.marks).toHaveLength(1);
		expect(summary.malformed).toBe(2);
	});

	it("refuses a mark that is not a bounded dialogue", () => {
		const projectDir = projectDirectory();

		expect(() => appendTargetFeedbackMark(projectDir, mark({ messages: [] }))).toThrow();
		expect(() => appendTargetFeedbackMark(projectDir, mark({
			messages: [{ role: "assistant", content: "x".repeat(MAX_TASK_TEXT_BYTES + 1) }],
		}))).toThrow(/byte bound/);
		expect(() => appendTargetFeedbackMark(projectDir, mark({ at: "not a timestamp" }))).toThrow();
		expect(existsSync(join(projectDir, TARGET_FEEDBACK_PATH))).toBe(false);
	});
});

describe("bounding a mark before it leaves the Target session", () => {
	it("redacts credentials, truncates a turn, and keeps only the most recent turns", () => {
		const turns = Array.from({ length: MAX_TASK_MESSAGES + 6 }, (_, index) => ({
			role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
			content: `turn ${index}`,
		}));
		turns.push({ role: "user", content: "  api_key: sk-abcdefghijklmnopqrstuvwxyz  " });
		turns.push({ role: "assistant", content: "я" .repeat(MAX_TASK_TEXT_BYTES) });
		turns.push({ role: "assistant", content: "   " });

		const bounded = boundTargetFeedbackDialogue(turns);

		expect(bounded).toHaveLength(MAX_TASK_MESSAGES);
		expect(bounded[bounded.length - 1]?.role).toBe("assistant");
		for (const turn of bounded) {
			expect(Buffer.byteLength(turn.content, "utf8")).toBeLessThanOrEqual(MAX_TASK_TEXT_BYTES);
		}
		const credential = bounded.find((turn) => turn.content.includes("api_key"));
		expect(credential?.content).toBe("api_key: [REDACTED]");
		// Empty turns never become a case turn.
		expect(bounded.some((turn) => turn.content.trim().length === 0)).toBe(false);
	});

	it("bounds a note to the same width a metadata value keeps", () => {
		expect(boundTargetFeedbackNote(undefined)).toBeUndefined();
		expect(boundTargetFeedbackNote("   ")).toBeUndefined();
		expect(boundTargetFeedbackNote("  не вызвал\n  инструмент ")).toBe("не вызвал инструмент");
		expect(boundTargetFeedbackNote("token=abcdefghijklmnop")).toBe("token=[REDACTED]");
		const long = boundTargetFeedbackNote("x".repeat(MAX_TARGET_FEEDBACK_NOTE_CHARS + 50));
		expect(long).toHaveLength(MAX_TARGET_FEEDBACK_NOTE_CHARS);
		expect(long?.endsWith("…")).toBe(true);
	});
});

describe("the inbox stays out of the model-facing surface", () => {
	it("is git-ignored by the scaffold and excluded from the isolated workspace", () => {
		const scaffoldRoot = mkdtempSync(join(tmpdir(), "ahde-feedback-scaffold-"));
		cleanupPaths.push(scaffoldRoot);
		const scaffolded = join(scaffoldRoot, "agent");
		scaffoldTarget(join(process.cwd(), "templates", "basic-agent"), scaffolded);

		appendTargetFeedbackMark(scaffolded, mark());

		expect(readFileSync(join(scaffolded, ".gitignore"), "utf8")).toContain("/imports/");
		// A marked reply never shows up as a change an operator has to explain.
		expect(execFileSync("git", ["-C", scaffolded, "status", "--porcelain=v1", "--untracked-files=all"], {
			encoding: "utf8",
		}).trim()).toBe("");

		const targetDir = makeTargetFixture(baseFixtureFiles({}));
		cleanupPaths.push(targetDir);
		appendTargetFeedbackMark(targetDir, mark());
		const workspace = materializeTargetWorkspaceSnapshot(loadTarget(targetDir), tmpdir());
		try {
			expect(existsSync(join(workspace.dir, "imports"))).toBe(false);
		} finally {
			disposeTargetWorkspaceSnapshot(workspace);
		}
		expect(readTargetFeedback(targetDir).marks).toHaveLength(1);
	});
});
