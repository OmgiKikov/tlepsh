#!/usr/bin/env node
// Independent offline check of the live pilot's simple numeric/source graders.
// Original evaluation bytes and candidate verdicts are never rewritten.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listEvalRunIndexesLenient, loadVerifiedEvalRun } from "../dist/eval.js";
import { lastAssistantText, openTrace } from "../dist/trace.js";

if (!process.argv[2]) throw new Error("Pass the completed synthetic Python pilot directory");
const root = resolve(process.argv[2]);
const pilot = JSON.parse(readFileSync(join(root, "results.json"), "utf8"));
assert.equal(pilot.synthetic, true);
assert.equal(pilot.scriptedResponses, false);
assert.notEqual(pilot.status, "running", "Wait for the author and measurements to finish before examining sealed answers");
const runsRoot = join(root, "target/runs");
const exactNumber = (text, value) => new RegExp(`(?<![\\d.,+−-])${value}(?!\\d|[.,]\\d)`).test(text);
assert.equal(exactNumber("500", "50"), false);
assert.equal(exactNumber("420", "0"), false);
assert.equal(exactNumber("-260", "260"), false);
assert.equal(exactNumber("500.5", "500"), false);
assert.equal(exactNumber("Баланс: 420.", "420"), true);
const listed = listEvalRunIndexesLenient(runsRoot);
assert.equal(listed.invalidCount, 0, "Do not omit unreadable evaluations");
const evaluations = listed.records.map(record => {
	const verified = loadVerifiedEvalRun(runsRoot, record.evalRunId);
	const rows = verified.runs.map(run => {
		const answer = lastAssistantText(openTrace(join(runsRoot, run.runId), run.trace.path, run.trace.sha256)) ?? "";
		const contradictions = [];
		for (const check of run.evalResults.graders) {
			const number = check.type === "output_contains" ? /(?:^|:)output_contains:"(-?\d+)"$/.exec(check.name)?.[1] : undefined;
			if (check.passed && number !== undefined && !exactNumber(answer, number)) contradictions.push({ kind: "numeric-substring", expected: number });
			if (check.passed && check.type === "cites_source" && check.checkSubject && !answer.includes(check.checkSubject)) contradictions.push({ kind: "source-overlap-without-explicit-citation", expected: check.checkSubject });
		}
		return { runId: run.runId, originalPass: run.evalResults.outcome === "pass", strictPass: run.evalResults.outcome === "pass" && contradictions.length === 0, contradictions };
	});
	return { evalRunId: record.evalRunId, label: record.label, purpose: record.purpose, visibility: record.evidenceVisibility,
		targetSha: record.target.gitSha, total: rows.length, originalPass: rows.filter(row => row.originalPass).length,
		strictPass: rows.filter(row => row.strictPass).length, contradictions: rows.filter(row => row.contradictions.length > 0) };
});
const report = { originalArtifactsUnchanged: true, limitation: "Exact numeric text and explicit source IDs still do not prove semantic correctness of every claim.", evaluations };
const output = join(root, "strict-audit.json");
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`Audit: ${output}`);
