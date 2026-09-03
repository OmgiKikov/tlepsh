import { describe, expect, it } from "vitest";
import { DEFAULT_PI_HARNESS_FILES } from "../src/manifest.js";
import {
	declaredHarnessRoots,
	harnessScopePaths,
	isDefaultPiHarness,
	matchesHarnessGlob,
	PI_HARNESS_SCOPE_PATHS,
	reservedHarnessPath,
	safeHarnessPath,
	withinDeclaredHarness,
} from "../src/domain/harness-surface.js";
import { CANDIDATE_SCOPE_POLICY, candidateScopeFor } from "../src/application/candidate-experiment.js";

/**
 * One matcher decides both sides of `manifest.harness.files`. These are the
 * sentences the rest of the system leans on: what `**` means, what `*` means,
 * and the exact claim that a Pi Target is unchanged by any of it.
 */
describe("the declared harness surface", () => {
	it("reads ** as one or more segments, never zero", () => {
		expect(matchesHarnessGlob("prompts/system.md", "prompts/**")).toBe(true);
		expect(matchesHarnessGlob("prompts/ru/system.md", "prompts/**")).toBe(true);
		// The directory is not a member of its own surface, which is exactly what
		// the write side has always meant by `data/**`.
		expect(matchesHarnessGlob("prompts", "prompts/**")).toBe(false);
		expect(matchesHarnessGlob("promptsy/system.md", "prompts/**")).toBe(false);
	});

	it("reads * as one segment and nothing across a separator", () => {
		expect(matchesHarnessGlob("docs/guide.md", "docs/*.md")).toBe(true);
		expect(matchesHarnessGlob("docs/ru/guide.md", "docs/*.md")).toBe(false);
		expect(matchesHarnessGlob("docs/guide.txt", "docs/*.md")).toBe(false);
		expect(matchesHarnessGlob("config/agent.v2.yaml", "config/agent.*.yaml")).toBe(true);
	});

	it("matches a literal declaration exactly", () => {
		expect(matchesHarnessGlob("prompts/system.md", "prompts/system.md")).toBe(true);
		expect(matchesHarnessGlob("prompts/system.md.bak", "prompts/system.md")).toBe(false);
		expect(matchesHarnessGlob("prompts/other.md", "prompts/system.md")).toBe(false);
	});

	it("refuses traversal, absolute roots and control characters before any glob", () => {
		for (const path of [
			"prompts/../agent.py",
			"../agent.py",
			"/etc/passwd",
			"prompts//system.md",
			"prompts/./system.md",
			"prompts\\system.md",
			"prompts/system.md\n",
		]) {
			expect(safeHarnessPath(path), path).toBe(false);
			expect(matchesHarnessGlob(path, "prompts/**"), path).toBe(false);
			expect(matchesHarnessGlob(path, "**"), path).toBe(false);
		}
		// And a declaration that traverses matches nothing at all.
		expect(matchesHarnessGlob("prompts/system.md", "prompts/../prompts/**")).toBe(false);
	});

	it("keeps the Pi default exactly the canonical layout", () => {
		expect(isDefaultPiHarness(DEFAULT_PI_HARNESS_FILES)).toBe(true);
		expect(isDefaultPiHarness(["AGENTS.md", "skills/**", "tools/**", "bin/**"])).toBe(true);
		// Order is identity here: a re-ordered list is a declaration, not the default.
		expect(isDefaultPiHarness(["skills/**", "AGENTS.md", "tools/**", "bin/**"])).toBe(false);
		expect(isDefaultPiHarness(["prompts/**"])).toBe(false);
		for (const path of ["AGENTS.md", "skills/check-dbo/SKILL.md", "tools/x/run", "bin/check_dbo"]) {
			expect(withinDeclaredHarness(path, DEFAULT_PI_HARNESS_FILES), path).toBe(true);
		}
		expect(withinDeclaredHarness("prompts/system.md", DEFAULT_PI_HARNESS_FILES)).toBe(false);
		expect(harnessScopePaths(DEFAULT_PI_HARNESS_FILES)).toEqual([...PI_HARNESS_SCOPE_PATHS]);
	});

	it("admits the declared file and refuses the operator's own code", () => {
		const declared = ["prompts/**"];
		expect(withinDeclaredHarness("prompts/system.md", declared)).toBe(true);
		expect(withinDeclaredHarness("agent.py", declared)).toBe(false);
		expect(withinDeclaredHarness("README.md", declared)).toBe(false);
		expect(withinDeclaredHarness("evals/development.jsonl", declared)).toBe(false);
	});

	it("names the literal roots a listing has to walk", () => {
		expect(declaredHarnessRoots(["prompts/**"])).toEqual(["prompts"]);
		expect(declaredHarnessRoots(["prompts/system.md"])).toEqual(["prompts/system.md"]);
		expect(declaredHarnessRoots(["docs/*.md", "config/**"])).toEqual(["config", "docs"]);
		// A root already inside another root is walked by its parent.
		expect(declaredHarnessRoots(["config/**", "config/ru/*.md"])).toEqual(["config"]);
		// A wildcard first segment has no root: the caller must widen or refuse.
		expect(declaredHarnessRoots(["p*/system.md"])).toEqual([]);
	});

	it("never lets a declaration reach host-owned files or the evidence", () => {
		for (const path of ["manifest.yaml", "evals/development.jsonl", "imports/tickets.jsonl", "data/kb/x.md", ".git/config"]) {
			expect(reservedHarnessPath(path), path).toBe(true);
		}
		for (const path of ["prompts/system.md", "AGENTS.md", "database/schema.sql"]) {
			expect(reservedHarnessPath(path), path).toBe(false);
		}
	});

	it("keeps the Pi candidate scope and its policy id byte for byte", () => {
		const pi = candidateScopeFor({});
		expect(pi.id).toBe(CANDIDATE_SCOPE_POLICY.id);
		expect(pi.id).toBe("candidate-harness-resources-v3");
		expect(pi.allowed).toEqual(["AGENTS.md", "manifest.yaml", "skills/**", "bin/**", "tools/**", "data/**"]);
		expect(candidateScopeFor({ harness: { files: ["AGENTS.md", "skills/**", "tools/**", "bin/**"] } }).id)
			.toBe(CANDIDATE_SCOPE_POLICY.id);

		const declared = candidateScopeFor({ harness: { files: ["prompts/**"] } });
		expect(declared.id).toBe("candidate-declared-harness-v1");
		expect(declared.allowed).toEqual(["manifest.yaml", "data/**", "prompts/**"]);
		// And the scope the experiment enforces admits exactly the declared file.
		expect(declared.allowed.some((glob) => matchesHarnessGlob("prompts/system.md", glob))).toBe(true);
		expect(declared.allowed.some((glob) => matchesHarnessGlob("agent.py", glob))).toBe(false);
	});
});
