import { t } from "../i18n.js";
import { redactTraceText } from "../trace.js";
import type { FailureMode } from "./improvement-brief.js";
import type { CandidateFlip, GraderExplanation, RunExplanation, Transcript } from "./run-explanation.js";

/** Structured facts emitted by the existing exact grader-reason parser. */
export type CheckObservation =
	| { kind: "required-tool"; name: string; arguments: string | null; recordedCalls: number }
	| { kind: "world-state"; path: string | null; state: "missing" | "different" | "missing-value" | "undeclared"; expected: string | null; actual: string | null }
	| { kind: "source"; source: string };

export interface RunReading {
	runId: string;
	taskId: string;
	repetitionNumber: number;
	kind: "execution" | "world" | "retrieval" | "tool" | "check" | "uncertain" | "pass";
	title: string;
	expectations: string[];
	observations: string[];
	answerQuote: { text: string; clipped: boolean } | null;
	checks: Array<{ name: string; reason: string }>;
	uncertainties: string[];
	comparison: CandidateFlip | null;
}

/** The same case-level change qualification in every presentation surface. */
export function runReadingChange(reading: RunReading): string {
	const comparison = reading.comparison;
	return !comparison ? t("reading.noChange") : comparison.mode === "aa-calibration" ? t("reading.noiseCheck")
		: t("reading.caseChange", { before: comparison.before, after: comparison.after });
}

const MAX_READING_CHECKS = 3;
const MAX_QUOTE_CHARS = 280;
const MAX_FACT_CHARS = 500;

function bounded(value: string, limit = MAX_FACT_CHARS): string {
	const clean = redactTraceText(value);
	return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

function recordedObservation(grader: GraderExplanation): string {
	const fact = grader.observation;
	if (fact?.kind === "source") return t("reading.sourceCheckObserved", { source: fact.source });
	if (fact?.kind !== "world-state" || !fact.path || fact.state === "undeclared") return grader.actual;
	if (fact.state === "missing") return t("reading.worldFieldMissing", { path: fact.path, expected: fact.expected ?? "—" });
	if (fact.state === "different") return t("reading.worldFieldDifferent", { path: fact.path, actual: fact.actual ?? "—", expected: fact.expected ?? "—" });
	return grader.actual;
}

function isMissingTicketField(grader: GraderExplanation): boolean {
	const fact = grader.observation;
	return fact?.kind === "world-state" && fact.state === "missing" && /^tickets\.\d+\./.test(fact.path ?? "");
}

/** Only the known ticket profile names a contract; arbitrary world paths stay literal. */
function ticketObservation(graders: readonly GraderExplanation[]): string {
	for (const grader of graders) {
		const fact = grader.observation;
		if (fact?.kind !== "world-state" || fact.state !== "missing" || !/^tickets\.\d+\.account$/.test(fact.path ?? "") || !fact.expected) continue;
		try {
			const account: unknown = JSON.parse(fact.expected);
			if (typeof account === "string" && account.trim()) return t("reading.ticketAccountMissing", { account: bounded(account) });
		} catch { /* An unrecognized expected value gets the generic ticket observation. */ }
	}
	return t("reading.ticketNotFound");
}

/** Human meaning from recorded facts. No semantic claim is inferred from the quoted answer. */
export function readRunOutcome(explanation: RunExplanation, transcript: Transcript | null): RunReading {
	const graders = explanation.graders.filter((grader) => !grader.abstained);
	const world = graders.filter((grader) => grader.observation?.kind === "world-state");
	const tool = graders.find((grader) => grader.observation?.kind === "required-tool");
	const source = graders.find((grader) => grader.observation?.kind === "source");
	const lastAnswer = transcript?.entries.findLast((entry) => entry.kind === "assistant" && entry.final && entry.text.trim());
	const quoteText = lastAnswer?.kind === "assistant" ? redactTraceText(lastAnswer.text) : null;
	const answerQuote = quoteText ? { text: bounded(quoteText, MAX_QUOTE_CHARS), clipped: quoteText.length > MAX_QUOTE_CHARS } : null;
	let kind: RunReading["kind"] = "check";
	let title = t("reading.check");
	let selected: GraderExplanation[] = graders.slice(0, MAX_READING_CHECKS);
	let observations: string[] = [];
	const uncertainties: string[] = [];

	if (explanation.outcome === "error") {
		kind = "execution";
		title = explanation.error?.sentence ?? t("reading.execution");
		selected = [];
		observations = [explanation.error?.detail ?? t("reading.executionUnknown")];
		uncertainties.push(t("reading.executionLimit"));
	} else if (explanation.outcome === "pass") {
		kind = "pass";
		title = t("reading.pass");
		selected = [];
		uncertainties.push(t("reading.passLimit"));
	} else if (graders.length === 0 && explanation.judgeAbstained > 0) {
		kind = "uncertain";
		title = t("reading.judgeUncertain");
		uncertainties.push(t("reading.judgeLimit"));
	} else if (world.length > 0 && world.every((grader) => grader.observation?.kind === "world-state" && grader.observation.state === "undeclared")) {
		kind = "uncertain";
		title = t("reading.worldUndeclared");
		selected = world.slice(0, MAX_READING_CHECKS);
		observations = selected.map(recordedObservation);
		uncertainties.push(t("reading.worldUndeclaredLimit"));
	} else if (world.length > 0) {
		kind = "world";
		const missing = world.filter((grader) => grader.observation?.kind === "world-state" && grader.observation.state === "missing");
		// A deliberately narrow vocabulary: the known ticket action AND its declared
		// missing ticket fields must agree. Arbitrary state paths get the generic reading.
		const ticket = tool?.observation?.kind === "required-tool" && tool.observation.name === "create_ticket" &&
			missing.some(isMissingTicketField);
		title = t(ticket ? "reading.ticketMissing" : missing.length > 0 ? "reading.resultMissing" : "reading.resultDifferent");
		selected = [...world, ...(tool ? [tool] : [])].slice(0, MAX_READING_CHECKS);
		observations = ticket
			? [ticketObservation(selected), ...selected.filter((grader) => !isMissingTicketField(grader)).map(recordedObservation)]
			: selected.map(recordedObservation);
		uncertainties.push(t("reading.worldLimit"));
	} else if (source || explanation.rag && ["retrieval-bypassed", "retrieval-miss", "answer-grounding-miss"].includes(explanation.rag.diagnosis)) {
		kind = "retrieval";
		const rag = explanation.rag;
		const diagnosis = rag?.diagnosis;
		title = t(diagnosis === "answer-grounding-miss" ? "reading.sourceUnused" : diagnosis === "retrieval-miss" ? "reading.sourceMissing" : diagnosis === "retrieval-bypassed" ? "reading.searchSkipped" : "reading.sourceCheck");
		selected = source ? [source] : graders.slice(0, MAX_READING_CHECKS);
		if (rag) {
			if (diagnosis === "retrieval-bypassed") observations.push(t("reading.noSearch"));
			else if (rag.expectedChunkIds.some((id) => rag.retrievedChunkIds.includes(id))) observations.push(t("reading.sourceReturned"));
			else if (diagnosis === "retrieval-miss") observations.push(t("reading.sourceNotReturned"));
		}
		observations.push(...selected.map(recordedObservation));
		uncertainties.push(t("reading.sourceLimit"));
	} else if (tool?.observation?.kind === "required-tool") {
		kind = "tool";
		title = t("reading.toolMissing", { tool: bounded(tool.observation.name) });
		selected = [tool];
		observations = [tool.actual];
		uncertainties.push(t("reading.toolLimit"));
	} else {
		observations = selected.map((grader) => grader.actual);
		uncertainties.push(t("reading.unknownLimit"));
	}
	if (!transcript && explanation.outcome !== "error") uncertainties.push(t("reading.traceMissing"));
	else if (transcript?.truncated) uncertainties.push(t("reading.traceClipped"));
	if (explanation.judgeAbstained > 0 && kind !== "uncertain") uncertainties.push(t("reading.judgeLimit"));
	if (graders.length > selected.length && selected.length > 0) uncertainties.push(t("reading.moreChecks", { count: graders.length - selected.length }));
	return {
		runId: explanation.runId, taskId: explanation.taskId, repetitionNumber: explanation.repetitionIndex + 1,
		kind, title: bounded(title),
		expectations: [...new Set(selected.flatMap((grader) => grader.expected ? [bounded(grader.expected)] : []))],
		observations: [...new Set(observations.map((value) => bounded(value)))],
		answerQuote: kind === "execution" ? null : answerQuote,
		checks: selected.map((grader) => ({ name: bounded(grader.graderName), reason: bounded(grader.reason) })),
		uncertainties, comparison: explanation.flip,
	};
}

/** Plain labels for a failure family, without pretending one example explains the whole group. */
export function humanFailureModeTitle(mode: Pick<FailureMode, "signature">): string | null {
	if (mode.signature.kind === "infrastructure-error") return t("reading.issueExecution");
	switch (mode.signature.checkCode) {
		case "world-state": return t("reading.issueWorld");
		case "cites-source": return t("reading.issueSource");
		case "required-tool": return mode.signature.subject ? t("reading.toolMissing", { tool: bounded(mode.signature.subject) }) : t("reading.issueTool");
		case "output-contains": case "output-matches": return t("reading.issueOutput");
		default: return null;
	}
}
