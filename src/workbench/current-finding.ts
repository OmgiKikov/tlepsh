import { basename, dirname } from "node:path";
import { explainRun, graderFindings, runOutcome, runTranscript, traceFacts } from "../application/run-explanation.js";
import { readRunOutcome, type RunReading } from "../application/run-reading.js";
import { compareUtf8 } from "../domain/comparison-gate.js";
import { loadVerifiedEvalRun, readEvalRunIndex, type EvalRunRecord } from "../eval.js";
import { executionKindOf } from "../manifest.js";
import { axisDifferences, commandProtocolFingerprint, hasKnownCommandUsageSemantics, hashValue, modelFingerprint, provenanceAxes } from "../provenance.js";
import { resolveContainedArtifactPath } from "../storage/paths.js";
import { commandTargetEnvironmentNames } from "../target/session-command.js";
import { openTrace } from "../trace.js";
import type { WorkbenchInventory } from "./inventory.js";
import { compatibleDevelopmentEvals } from "./resolution.js";
import type { WorkbenchView } from "./types.js";

/** One recorded observation of the active revision, never a new-run prediction. */
export interface CurrentAgentFinding {
	evalRunId: string;
	finishedAt: string;
	reading: RunReading;
}

/** A header preview must not open an arbitrarily large evaluation on startup. */
export const CURRENT_FINDING_MAX_RUNS = 200;

function currentInstrument(inventory: WorkbenchInventory, record: EvalRunRecord): boolean {
	const target = inventory.target!;
	const execution = target.manifest.execution;
	const recorded = record.provenance.execution;
	if (!hasKnownCommandUsageSemantics(recorded) || recorded.workspace !== "isolated-copy-v1" ||
		record.target.toolsetHash !== target.toolsetHash || !record.target.workspaceHash || !record.target.preparedToolHomeHash) return false;
	const command = executionKindOf(execution) === "command";
	const environment = command
		? commandTargetEnvironmentNames({ environmentAllowlist: execution.environmentAllowlist, apiKeyEnv: target.manifest.model.apiKeyEnv })
		: [...new Set(["HOME", "LANG", "PATH", "TMPDIR", ...execution.environmentAllowlist.filter((name) => process.env[name] !== undefined)])].sort();
	const { commandProtocol: _oldProtocol, ...recordedExecution } = recorded;
	// Effective sandbox/filesystem are recorded observations. Re-probing them
	// would execute commands or tool setup on a read. All configured measurement
	// inputs are compared; no claim is made about the outcome of a future run.
	const expected = provenanceAxes({
		runtime: target.runtime,
		model: modelFingerprint(target.manifest.model),
		judge: target.manifest.evalSuite.judge ? modelFingerprint(target.manifest.evalSuite.judge) : null,
		simulatedUser: target.manifest.evalSuite.simulatedUser ? modelFingerprint(target.manifest.evalSuite.simulatedUser) : undefined,
		execution: {
			...recordedExecution,
			agent: command ? "command-v1" : "pi-v1",
			tools: [...execution.tools], environment, network: execution.network,
			...(command ? { commandProtocol: commandProtocolFingerprint(execution.command!.protocolVersion) } : {}),
		},
		eval: { suiteHash: record.suiteHash, datasetHash: record.datasetHash },
	});
	return axisDifferences(record.provenance, expected).length === 0;
}

/** Uses only the already-selected reviewed surface, then verifies one public eval. */
export function currentFindingFromInventory(
	inventory: WorkbenchInventory,
	view: Pick<WorkbenchView, "blockers" | "target">,
): CurrentAgentFinding | null {
	if (!inventory.target || view.target.status !== "ready" || view.blockers.length > 0 ||
		inventory.integrityBlockers.length > 0 || !/^[a-f0-9]{40,64}$/.test(inventory.target.gitSha)) return null;
	try {
		const available = compatibleDevelopmentEvals(inventory);
		const focused = inventory.validFocus["eval-run"]?.id;
		const selected = available.find((record) => record.evalRunId === focused) ?? available[0];
		if (!selected) return null;
		const index = readEvalRunIndex(inventory.runsRoot, selected.evalRunId);
		// Refuse an altered/sealed index before opening any member run or trace.
		if (hashValue(index) !== hashValue(selected) || index.evidenceVisibility !== "development" ||
			index.purpose !== "evidence" || !index.runArtifacts || index.runIds.length > CURRENT_FINDING_MAX_RUNS ||
			!currentInstrument(inventory, index)) return null;
		const verified = loadVerifiedEvalRun(inventory.runsRoot, index.evalRunId);
		if (!verified.hasRunHashes || hashValue(verified.record) !== hashValue(index)) return null;
		const run = [...verified.runs].sort((a, b) =>
			Number(runOutcome(a) === "pass") - Number(runOutcome(b) === "pass") ||
			compareUtf8(a.taskId, b.taskId) || a.repetitionIndex - b.repetitionIndex,
		)[0];
		if (!run || !run.trace.sha256) return null;
		const path = resolveContainedArtifactPath(inventory.runsRoot, run.runId, run.trace.path);
		const messages = openTrace(dirname(path), basename(path), run.trace.sha256);
		const explanation = explainRun({ run, graders: graderFindings(run), facts: traceFacts(messages), messages, modes: [], flip: null });
		return { evalRunId: index.evalRunId, finishedAt: index.finishedAt, reading: readRunOutcome(explanation, runTranscript(messages)) };
	} catch {
		// A decorative finding can disappear; it cannot replace the Workbench's
		// readiness or make unreadable evidence sound like a current failure.
		return null;
	}
}
