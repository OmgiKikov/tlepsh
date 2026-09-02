#!/usr/bin/env node
// What the Builder pays for its persona on every turn.
//
//   node scripts/prompt-size.mjs [path/to/AGENTS.md]
//
// Composes the system prompt the same way `composeBuilderSystemPrompt` does —
// the persona plus every inlined workflow skill — and prints its line count,
// character count and a chars/4 token estimate. Pass a path to measure an
// older revision: `git show HEAD:builders/ahde/AGENTS.md > /tmp/before.md`.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const personaPath = resolve(process.argv[2] ?? join(packageRoot, "builders", "ahde", "AGENTS.md"));
const skillsRoot = join(packageRoot, "builders", "ahde", "skills");
const skillPaths = existsSync(skillsRoot)
	? readdirSync(skillsRoot)
		.map((name) => join(skillsRoot, name, "SKILL.md"))
		.filter((path) => existsSync(path))
	: [];

function compose(agentsMd, paths) {
	const sections = paths.map((path) => {
		const raw = readFileSync(path, "utf8");
		const frontmatter = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
		const body = (frontmatter ? raw.slice(frontmatter[0].length) : raw).trim();
		const name = /^name:\s*(.+)$/m.exec(frontmatter?.[1] ?? "")?.[1]?.trim() ?? basename(dirname(path));
		const description = /^description:\s*(.+)$/m.exec(frontmatter?.[1] ?? "")?.[1]?.trim();
		return [`## Skill: ${name}`, ...(description ? [`_${description}_`, ""] : [""]), body].join("\n");
	});
	if (sections.length === 0) return agentsMd.trimEnd();
	return [
		agentsMd.trimEnd(),
		"",
		"# Workflow skills",
		"",
		"These packaged skills are the detailed procedures behind the typical loop. Follow the one that matches the operator's request.",
		"",
		...sections.flatMap((section) => [section, ""]),
	].join("\n").trimEnd();
}

const prompt = compose(readFileSync(personaPath, "utf8"), skillPaths);
const lines = prompt.split("\n").length;
const chars = prompt.length;
process.stdout.write(
	`${personaPath}\n` +
	`  skills inlined: ${skillPaths.length}\n` +
	`  lines: ${lines}\n` +
	`  chars: ${chars}\n` +
	`  tokens (chars/4): ~${Math.round(chars / 4)}\n`,
);
