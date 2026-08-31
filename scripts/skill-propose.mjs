#!/usr/bin/env node
// Stand-in for the `ahde propose --branch` / `ahde apply` the SKILL says do not
// exist yet. Takes a Target dir, the source EvalRun, and new file contents, and
// leaves behind exactly what `ahde candidate --builder-run` needs:
// an approved Spec, a typed CandidateProposal, and an apply receipt on a branch.
//
//   node scripts/skill-propose.mjs --target <dir> --project <id> --eval <erunId> \
//     --file <relpath>=<contentFile> [--file ...] --branch candidate/<slug> \
//     --summary <text> --reason <text> [--run-id <id>]
//
// Application services it needed (this list IS the spec for `ahde propose/apply`):
//   dist/spec.js                        saveSpecSnapshot        (approved Spec — no CLI exists)
//   dist/diagnosis.js                   diagnoseEvalRun         (has a CLI: `ahde diagnose`)
//   dist/application/improvement-brief.js
//                                       compileImprovementBrief, deriveEvidenceLinkedProposalSelection
//                                                               (no CLI)
//   dist/application/harness-authoring.js
//                                       wholeFileDiff           (no CLI)
//   dist/builders/adapters.js           BuilderRunRecordSchema  (no CLI)
//   dist/application/builder-proposal.js
//                                       runApprovedSpecBuilderProposal, applyBuilderProposal
//                                                               (no CLI)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runApprovedSpecBuilderProposal, applyBuilderProposal } from "../dist/application/builder-proposal.js";
import { compileImprovementBrief, deriveEvidenceLinkedProposalSelection } from "../dist/application/improvement-brief.js";
import { wholeFileDiff } from "../dist/application/harness-authoring.js";
import { BuilderRunRecordSchema } from "../dist/builders/adapters.js";
import { diagnoseEvalRun } from "../dist/diagnosis.js";
import { saveSpecSnapshot } from "../dist/spec.js";

const argv = process.argv.slice(2);
const files = [];
const flag = (name) => {
	const index = argv.indexOf(`--${name}`);
	return index === -1 ? undefined : argv[index + 1];
};
for (let i = 0; i < argv.length; i += 1) {
	if (argv[i] === "--file") {
		const [rel, source] = argv[i + 1].split("=");
		files.push({ path: rel, after: readFileSync(source, "utf8") });
	}
}
const targetDir = resolve(flag("target") ?? ".");
const projectId = flag("project") ?? "default";
const evalRunId = flag("eval");
const branch = flag("branch") ?? "candidate/skill";
const summary = flag("summary") ?? "Harness change from the skill walkthrough.";
const reason = flag("reason") ?? "Reviewed the bounded diff.";
const runId = flag("run-id") ?? `builder-skill-${Date.now().toString(36)}`;
const runsRoot = process.env.AHDE_RUNS_DIR ?? resolve(targetDir, "runs");
const stateRoot = process.env.AHDE_STATE_DIR ?? resolve(targetDir, ".ahde");
if (!evalRunId || files.length === 0) throw new Error("need --eval <erunId> and at least one --file <rel>=<src>");

const git = (...args) => execFileSync("git", ["-C", targetDir, ...args], { encoding: "utf8" }).trim();
const baseTargetSha = git("rev-parse", "HEAD");
const now = () => new Date().toISOString();

// 1. Approved Spec. `ahde candidate --builder-run` refuses without one, and no
//    CLI command writes it; spec.md on disk is not this object.
const spec = saveSpecSnapshot({
	stateRoot, projectId, status: "approved",
	spec: {
		schemaVersion: 1,
		title: "Агент поддержки по возвратам",
		purpose: "Отвечать покупателям про сроки и порядок возврата.",
		users: ["покупатель интернет-магазина"],
		jobs: ["ответить на вопрос о возврате"],
		inputs: ["сообщение покупателя на русском"],
		allowedActions: ["ответить текстом"],
		successCriteria: ["ответ по-русски", "срок 30 дней с даты доставки", "заявка в личном кабинете → «Возвраты»"],
		constraints: ["без инструментов", "без сети"],
		openQuestions: [],
	},
});

// 2. Bind the proposal to the diagnosed evidence exactly as Builder Pi does.
const diagnosis = diagnoseEvalRun(runsRoot, evalRunId);
const brief = compileImprovementBrief(runsRoot, diagnosis);
const proposalBasis = {
	algorithmId: brief.algorithmId,
	evalRunId: brief.evalRunId,
	diagnosisId: brief.diagnosisId,
	briefId: brief.briefId,
	failureModeIds: brief.modes.filter((m) => m.decision === "propose-harness-change").map((m) => m.failureModeId),
};
const selected = deriveEvidenceLinkedProposalSelection(brief, proposalBasis);
const evidenceRefs = [...new Set(selected.diagnoses.flatMap((item) => item.evidence))];

// 3. Whole-file diffs against the committed base, rendered by the same helper
//    the real Builder uses, so the apply step sees a byte-identical artifact.
const changes = files.map(({ path, after }) => {
	const before = readFileSync(resolve(targetDir, path));
	return {
		path,
		baseSha256: `sha256:${createHash("sha256").update(before).digest("hex")}`,
		unifiedDiff: wholeFileDiff({ path, before: { mode: "100644", content: before }, after, afterMode: "100644" }),
		rationale: summary,
		evidenceRefs,
	};
});
const proposal = {
	schemaVersion: 1,
	decision: "propose",
	baseTargetSha,
	summary,
	diagnoses: selected.diagnoses,
	changes,
	risks: ["Instruction-only change; wording is not benchmark-verbatim."],
	validationPlan: ["Matched development comparison plus the sealed holdout gate"],
};

// 4. A local adapter that just returns the authored proposal. The engine keeps
//    ownership of hashing, path allowlisting, and the run record.
const capabilities = {
	eventStream: true, structuredOutput: true, usage: false, cost: false,
	sessionId: false, cancellation: true, isolation: "tool-free-executor",
};
const adapter = {
	backend: "skill-shim",
	capabilities,
	async probe() {
		return { backend: "skill-shim", available: true, version: "skill-shim 1.0.0", capabilities, error: null };
	},
	async run(request) {
		return BuilderRunRecordSchema.parse({
			schemaVersion: 1, runId: request.runId, backend: "skill-shim",
			backendVersion: "skill-shim 1.0.0", capabilities,
			baseTargetSha: request.baseTargetSha, startedAt: now(), finishedAt: now(),
			status: "completed", proposal, model: null, sessionId: null, usage: null,
			costUsd: null, traceLevel: "full", rawEvents: ['{"type":"final"}'], error: null,
		});
	},
};

const builder = await runApprovedSpecBuilderProposal({
	adapter,
	approvedSpec: { stateRoot, projectId, specId: spec.id },
	targetDir,
	allowedPaths: ["AGENTS.md", "skills/**", "bin/**", "tools/**"],
	sourceEvalRunId: evalRunId,
	proposalBasis,
	runsRoot,
	timeoutMs: 10_000,
	runId,
});

const applied = applyBuilderProposal({
	repoDir: targetDir, runsRoot, runId: builder.record.runId,
	requestedBranch: branch, actor: { kind: "human", id: "skill-walkthrough" }, reason,
});

console.log(`spec         ${spec.id} (approved)`);
console.log(`diagnosis    ${diagnosis.diagnosisId} · brief ${brief.briefId}`);
console.log(`proposal     ${builder.proposalPath}`);
console.log(`builder-run  ${builder.record.runId}`);
console.log(`candidate    ${applied.receipt.candidateSha} on ${applied.receipt.branch}`);
console.log(`checkout     ${git("rev-parse", "--abbrev-ref", "HEAD")} (unchanged)`);
