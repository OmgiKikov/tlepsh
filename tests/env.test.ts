import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { describeEnvVar, fingerprint, loadDotEnv } from "../src/env.js";

let dir: string;

function makeEnvDir(files: Record<string, string>): string {
	dir = mkdtempSync(join(tmpdir(), "ahde-env-"));
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(dir, name), content);
	}
	return dir;
}

afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("fingerprint", () => {
	it("never leaks the secret, shows tail and length", () => {
		expect(fingerprint("sk-or-v1-abcdef123456")).toBe("…3456 (len 21)");
		expect(fingerprint(undefined)).toBe("(unset)");
	});
});

describe("loadDotEnv", () => {
	it("loads values that are absent from the process env", () => {
		const cwd = makeEnvDir({ ".env": "FOO=bar\n" });
		const env: Record<string, string | undefined> = {};
		const report = loadDotEnv(cwd, env);
		expect(env.FOO).toBe("bar");
		expect(report.sources.get("FOO")).toBe(".env");
		expect(report.conflicts).toEqual([]);
	});

	it("gives .env.local precedence over .env", () => {
		const cwd = makeEnvDir({ ".env": "FOO=from-env\n", ".env.local": "FOO=from-local\n" });
		const env: Record<string, string | undefined> = {};
		const report = loadDotEnv(cwd, env);
		expect(env.FOO).toBe("from-local");
		expect(report.sources.get("FOO")).toBe(".env.local");
	});

	it("keeps the shell value and reports the conflict (the stale-key trap)", () => {
		const cwd = makeEnvDir({ ".env": "KEY=fresh-key-0c80\n" });
		const env: Record<string, string | undefined> = { KEY: "stale-key-aef3" };
		const report = loadDotEnv(cwd, env);
		expect(env.KEY).toBe("stale-key-aef3");
		expect(report.sources.get("KEY")).toBe("shell");
		expect(report.conflicts).toHaveLength(1);
		expect(report.conflicts[0]).toMatchObject({
			name: "KEY",
			file: ".env",
			shellFingerprint: "…aef3 (len 14)",
			fileFingerprint: "…0c80 (len 14)",
		});
	});

	it("does not report a conflict when shell and file agree", () => {
		const cwd = makeEnvDir({ ".env": "KEY=same\n" });
		const env: Record<string, string | undefined> = { KEY: "same" };
		expect(loadDotEnv(cwd, env).conflicts).toEqual([]);
	});

	it("handles comments, export prefix, quotes and inline comments", () => {
		const cwd = makeEnvDir({
			".env": [
				"# full line comment",
				"",
				"export EXPORTED=value1",
				'QUOTED="has spaces"',
				"SINGLE='single quoted'",
				"INLINE=value2 # trailing comment",
				"HASHINVALUE=abc#notcomment",
			].join("\n"),
		});
		const env: Record<string, string | undefined> = {};
		loadDotEnv(cwd, env);
		expect(env.EXPORTED).toBe("value1");
		expect(env.QUOTED).toBe("has spaces");
		expect(env.SINGLE).toBe("single quoted");
		expect(env.INLINE).toBe("value2");
		expect(env.HASHINVALUE).toBe("abc#notcomment");
	});

	it("is a no-op when no env files exist", () => {
		const cwd = makeEnvDir({});
		const report = loadDotEnv(cwd, {});
		expect(report.sources.size).toBe(0);
		expect(report.conflicts).toEqual([]);
	});
});

describe("describeEnvVar", () => {
	it("names the source of a variable", () => {
		const cwd = makeEnvDir({ ".env": "K=abcd1234\n" });
		const env: Record<string, string | undefined> = {};
		const report = loadDotEnv(cwd, env);
		expect(describeEnvVar("K", report, env as NodeJS.ProcessEnv)).toBe("…1234 (len 8) from .env");
		expect(describeEnvVar("MISSING", report, env as NodeJS.ProcessEnv)).toBe("(unset) from (unset)");
	});
});
