#!/usr/bin/env node
// Stand-in for `ahde log --target .` / `ahde log --json`, which the SKILL calls
// "the deliverable" but which does NOT exist as a CLI command (`usage error:
// unknown command "log"`, exit 2). Renders the same growth line from the run
// artifacts the engine already writes.
//
//   node scripts/skill-shim-log.mjs --target <dir> [--json]
//
// Application services it needed (the spec for a real `ahde log`):
//   dist/application/experiment-history.js  compileExperimentHistory, renderExperimentHistory
//   plus the promotion tag on the Target repo (git for-each-ref refs/tags)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileExperimentHistory, renderExperimentHistory } from "../dist/application/experiment-history.js";

const argv = process.argv.slice(2);
const flag = (name) => {
	const index = argv.indexOf(`--${name}`);
	return index === -1 ? undefined : argv[index + 1];
};
const targetDir = resolve(flag("target") ?? ".");
const runsRoot = process.env.AHDE_RUNS_DIR ?? join(targetDir, "runs");
const asJson = argv.includes("--json");

const history = compileExperimentHistory({ runsRoot });
const tags = execFileSync("git", ["-C", targetDir, "for-each-ref", "--format=%(refname:short)\t%(objectname)\t%(contents)", "refs/tags"], { encoding: "utf8" })
	.split("\n").filter(Boolean)
	.map((line) => {
		const [tag, sha, ...rest] = line.split("\t");
		let annotation = {};
		try { annotation = JSON.parse(rest.join("\t").trim().split("\n").filter((l) => l.startsWith("{"))[0] ?? "{}"); } catch { /* plain tag */ }
		return { tag, sha, ...annotation };
	});

// Score + cost for a shipped version come from that candidate's own record.
const versions = tags.map((tag) => {
	if (!tag.candidateId) return tag;
	let record;
	try {
		record = JSON.parse(readFileSync(join(runsRoot, "candidates", tag.candidateId, "candidate.json"), "utf8"));
	} catch { return tag; }
	const evaluated = record.events.find((event) => event.type === "evaluated");
	const development = evaluated?.evaluation?.development?.comparison;
	const sealed = evaluated?.evaluation?.sealedHoldout?.comparison;
	return {
		...tag,
		developmentVerdict: development?.verdict ?? null,
		developmentScore: development?.summary?.candidateScore ?? null,
		developmentCi: development?.summary?.confidence95 ?? null,
		sealedVerdict: sealed?.verdict ?? null,
		sealedTasks: sealed?.summary?.taskCount ?? null,
		costUsd: development?.resources?.candidate?.costUsd ?? null,
	};
});

if (asJson) {
	console.log(JSON.stringify({ versions, attempts: history.attempts, omitted: history.omitted }, null, 2));
} else {
	console.log("version  score       CI                 sealed  cost/run  candidate");
	for (const version of versions) {
		const score = version.developmentScore === null || version.developmentScore === undefined
			? "  —   " : `${(version.developmentScore * 100).toFixed(1)}%`.padStart(6);
		const ci = version.developmentCi
			? `${(version.developmentCi.low * 100).toFixed(0)}…${(version.developmentCi.high * 100).toFixed(0)}pp`.padEnd(16)
			: "—".padEnd(16);
		console.log(
			`${(version.tag ?? "?").padEnd(8)} ${score}      ${ci}   ` +
			`${String(version.sealedVerdict ?? "—").padEnd(6)}  ` +
			`$${(version.costUsd ?? 0).toFixed(4)}   ${(version.candidateId ?? version.sha).slice(0, 24)}`,
		);
	}
	console.log("");
	for (const line of renderExperimentHistory(history)) console.log(line);
}
