/**
 * The critic: a second reading of the cases themselves, never of the agent.
 *
 * A basket is only as good as its worst case. The critic asks the judge model
 * whether each case can be solved from what the agent is allowed to see — the
 * cited source, the world state, the declared tools — whether its success
 * criteria are unambiguous, whether its conditions agree with one another, and
 * whether its checks say what the source says. It returns a verdict per case:
 *
 *   - `valid`: nothing to change;
 *   - `repair`: a concrete fix makes it valid, and the fix is attached;
 *   - `invalid`: the case cannot be made to measure anything, and the reasons say why;
 *   - `unreviewed`: the critic could not answer (a failed call, an unparsable reply).
 *
 * Two things the critic must never do. It never sees how the agent scored: a
 * zero pass rate is the agent's problem until the critic finds a fault in the
 * case, and a hard case is not a faulty one. And it never calls an ambiguous
 * request a defect: with `difficulty: clarify` the ambiguity is the point, and
 * only the case's own criteria are read for ambiguity.
 *
 * Findings are written into a receipt keyed by the subject's hash, so the same
 * draft is never paid for twice and every later reading of the basket can say
 * which failing case the critic doubted.
 */
import { z } from "zod";
import { callEvaluatorModel, EvaluatorModelError, type EvaluatorModelMetrics } from "../evaluator-model.js";
import { GraderSpec, type CaseCoverage, type CaseSource, type SimulatedUserSpec, type TargetManifest, type World } from "../manifest.js";
import { canonicalJson, hashValue } from "../provenance.js";
import type { AgentSpec } from "../spec.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";
import { redactTraceText } from "../trace.js";
import { projectStateDir } from "../storage/paths.js";
import { join } from "node:path";
import { existsSync } from "node:fs";

export const CRITIC_VERDICTS = ["valid", "repair", "invalid", "unreviewed"] as const;
export const CriticVerdictSchema = z.enum(CRITIC_VERDICTS);
export type CriticVerdict = z.infer<typeof CriticVerdictSchema>;

const MAX_REASONS = 8;
const MAX_REASON_CHARS = 500;
const MAX_FIX_TEXT_BYTES = 32_000;
const MAX_SOURCE_CHARS = 6_000;
/** Cases per judge call. The plan prices a critic pass as `ceil(cases / CRITIC_BATCH_SIZE)` calls. */
export const CRITIC_BATCH_SIZE = 8;

export const CriticFixSchema = z.strictObject({
	input: z.string().min(1).max(MAX_FIX_TEXT_BYTES).optional(),
	expected: z.string().min(1).max(MAX_FIX_TEXT_BYTES).optional(),
	graders: z.array(GraderSpec).min(1).max(16).optional(),
	note: z.string().min(1).max(1_000).optional(),
});
export type CriticFix = z.infer<typeof CriticFixSchema>;

export const CriticFindingSchema = z.strictObject({
	taskId: z.string().min(1).max(500),
	verdict: CriticVerdictSchema,
	reasons: z.array(z.string().min(1).max(MAX_REASON_CHARS)).max(MAX_REASONS),
	fix: CriticFixSchema.optional(),
});
export type CriticFinding = z.infer<typeof CriticFindingSchema>;

export const CriticCountsSchema = z.strictObject({
	valid: z.number().int().nonnegative(),
	repair: z.number().int().nonnegative(),
	invalid: z.number().int().nonnegative(),
	unreviewed: z.number().int().nonnegative(),
});
export type CriticCounts = z.infer<typeof CriticCountsSchema>;

export const CriticSubjectSchema = z.strictObject({
	kind: z.enum(["corpus-draft", "development-corpus", "generated-exam"]),
	id: z.string().min(1).max(200),
	hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type CriticSubject = z.infer<typeof CriticSubjectSchema>;

export const CriticReceiptSchema = z.strictObject({
	schemaVersion: z.literal(1),
	kind: z.literal("case-critic"),
	id: z.string().regex(/^critic-[0-9a-f]{64}$/),
	projectId: z.string().min(1).max(200),
	subject: CriticSubjectSchema,
	judge: z.strictObject({ provider: z.string().min(1), id: z.string().min(1) }),
	findings: z.array(CriticFindingSchema),
	counts: CriticCountsSchema,
	spend: z.strictObject({ calls: z.number().int().nonnegative(), tokens: z.number().int().nonnegative(), costUsd: z.number().nonnegative() }),
	createdAt: z.iso.datetime({ offset: true }),
});
export type CriticReceipt = z.infer<typeof CriticReceiptSchema>;

/** What the critic is shown about one case: the case, and the source it cites, as text. */
export interface CriticCase {
	task: {
		id: string;
		input: string;
		expected?: string | undefined;
		messages?: readonly { role: string; content: string }[] | undefined;
		simulatedUser?: SimulatedUserSpec | undefined;
		world?: World | undefined;
		graders?: readonly GraderSpec[] | undefined;
		coverage?: CaseCoverage | undefined;
		source?: CaseSource | undefined;
	};
	/** How the source is named to the critic: a path, “the approved Spec”, “imports/x.csv row 4”. */
	sourceLabel: string;
	/** The source's own text, or null when the case cites nothing readable. */
	sourceText: string | null;
}

export interface CritiqueCasesOptions {
	judge: TargetManifest["model"];
	/** The approved Spec, as text the critic can read. */
	specText: string;
	/** Names of the tools the agent may call. */
	tools: readonly string[];
	cases: readonly CriticCase[];
	/** Where every exchange with the judge is written, one file per batch. */
	sidecarDir: string;
	batchSize?: number;
	signal?: AbortSignal;
}

export interface CritiqueCasesResult {
	findings: CriticFinding[];
	spend: EvaluatorModelMetrics;
}

export const CRITIC_SYSTEM = [
	"You review evaluation cases written for an AI agent. You judge the CASE, never the agent:",
	"you are not told how the agent scored, and a hard case is not a faulty one.",
	"",
	"For every case decide one verdict:",
	"- valid: the case can be solved from what the agent can see, its success criteria are",
	"  unambiguous, its conditions agree with one another, and its checks say what the source says.",
	"- repair: one concrete change makes it valid. Give that change in \"fix\": a corrected",
	"  \"expected\", corrected \"graders\" (same grader types as shown), or a corrected \"input\",",
	"  plus a one-line \"note\".",
	"- invalid: it cannot be made to measure anything. Say why in \"reasons\".",
	"",
	"What makes a case invalid or in need of repair:",
	"1. It cannot be solved from the agent's side: the cited source text does not hold the answer,",
	"   the world state does not hold the fact, and no declared tool could fetch it.",
	"2. Its success criteria are ambiguous: two reasonable correct answers, and the checks accept",
	"   only one of them; or a check that a correct answer would still fail.",
	"3. Its conditions contradict each other: knownFacts against world state, expected against the",
	"   source, a check against the world the case declares.",
	"4. A check is wrong: output_contains names a value the source does not state; a world_state",
	"   expectation no allowed action could produce; a tool_called for a tool that does not exist.",
	"5. It duplicates another case in this batch (same question, same facts, reworded).",
	"6. It asks for something outside the agent's allowed actions — unless the case's difficulty is",
	"   out-of-scope, where declining is exactly the point.",
	"",
	"What is NOT a defect:",
	"- An ambiguous or underspecified REQUEST when the case's difficulty is clarify: then check only",
	"  that the checks describe a good clarifying question rather than an invented answer.",
	"- A hard, adversarial, or unusual request. Difficulty is welcome.",
	"- A trap (difficulty policy-trap, no-answer): the wrong value the case excludes is a feature.",
	"",
	"Rules:",
	"- Reasons are short, specific and about the case: name the field and what is wrong with it.",
	"- Never invent facts the source does not state; never propose a fix that needs them.",
	"- Answer with one JSON object and nothing else:",
	"  {\"findings\": [{\"case\": 1, \"verdict\": \"valid\" | \"repair\" | \"invalid\", \"reasons\": [\"...\"], \"fix\": {\"expected\": \"...\", \"graders\": [...], \"input\": \"...\", \"note\": \"...\"}}]}",
	"- \"fix\" only with verdict repair; \"reasons\" may be empty only with verdict valid.",
	"- Number the findings by the case numbers shown; one finding per case; every case gets one.",
].join("\n");

/** The approved Spec in the shape the critic reads it: one section per field. */
export function specTextOf(spec: AgentSpec): string {
	const list = (items: readonly string[]): string => items.length === 0 ? "(none)" : items.map((item) => `- ${item}`).join("\n");
	return [
		`# ${spec.title}`,
		"",
		spec.purpose,
		"",
		"## Users", list(spec.users),
		"## Jobs", list(spec.jobs),
		"## Inputs", list(spec.inputs),
		"## Allowed actions", list(spec.allowedActions),
		"## Success criteria", list(spec.successCriteria),
		"## Constraints", list(spec.constraints),
		"## Open questions", list(spec.openQuestions),
	].join("\n");
}

function boundedText(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated for the critic]`;
}

function caseText(index: number, item: CriticCase): string {
	const { task } = item;
	const lines = [`# Case ${index + 1} (id ${task.id})`];
	if (task.coverage) lines.push(`coverage: ${canonicalJson(task.coverage)}`);
	lines.push(`input: ${task.input}`);
	if (task.messages) lines.push(`messages: ${canonicalJson(task.messages)}`);
	if (task.simulatedUser) lines.push(`simulatedUser: ${canonicalJson(task.simulatedUser)}`);
	if (task.world !== undefined) lines.push(`world: ${boundedText(canonicalJson(task.world), MAX_SOURCE_CHARS)}`);
	if (task.expected !== undefined) lines.push(`expected: ${task.expected}`);
	lines.push(`graders: ${canonicalJson(task.graders ?? [])}`);
	lines.push(`## Source: ${item.sourceLabel}`);
	lines.push(item.sourceText === null ? "(no source text is readable for this case)" : boundedText(item.sourceText, MAX_SOURCE_CHARS));
	return lines.join("\n");
}

export function criticUserPrompt(options: Pick<CritiqueCasesOptions, "specText" | "tools">, batch: readonly CriticCase[]): string {
	return [
		"# The agent's specification",
		"",
		options.specText.trim(),
		"",
		"# Declared tools the agent may call",
		"",
		options.tools.length === 0 ? "(none)" : options.tools.map((tool) => `- ${tool}`).join("\n"),
		"",
		"# Cases",
		"",
		...batch.map((item, index) => `${caseText(index, item)}\n`),
		`Return one finding for each of the ${batch.length} case(s).`,
	].join("\n");
}

const ReplyFindingSchema = z.object({
	case: z.number().int().min(1),
	verdict: z.enum(["valid", "repair", "invalid"]),
	reasons: z.array(z.string()).optional(),
	fix: z.unknown().optional(),
});
const ReplySchema = z.object({ findings: z.array(ReplyFindingSchema) });

function extractJson(text: string): unknown {
	const trimmed = text.trim().replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "");
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start === -1 || end <= start) return null;
		try {
			return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
		} catch {
			return null;
		}
	}
}

function cleanReasons(reasons: readonly string[] | undefined): string[] {
	return (reasons ?? [])
		.map((reason) => redactTraceText(String(reason)).replace(/\s+/gu, " ").trim().slice(0, MAX_REASON_CHARS))
		.filter((reason) => reason.length > 0)
		.slice(0, MAX_REASONS);
}

function cleanFix(fix: unknown): CriticFix | undefined {
	if (typeof fix !== "object" || fix === null) return undefined;
	const raw = fix as Record<string, unknown>;
	const candidate: Record<string, unknown> = {};
	for (const key of ["input", "expected", "note"] as const) {
		if (typeof raw[key] === "string" && raw[key].trim().length > 0) candidate[key] = redactTraceText(raw[key]);
	}
	if (Array.isArray(raw.graders)) {
		const graders = raw.graders.map((grader) => GraderSpec.safeParse(grader)).filter((result) => result.success).map((result) => result.data);
		if (graders.length > 0) candidate.graders = graders;
	}
	const parsed = CriticFixSchema.safeParse(candidate);
	return parsed.success && Object.keys(parsed.data).length > 0 ? parsed.data : undefined;
}

/** Read one batch reply into findings; anything the reply does not cover is `unreviewed`, never guessed. */
export function parseCriticReply(text: string, batch: readonly CriticCase[]): CriticFinding[] {
	const parsed = ReplySchema.safeParse(extractJson(text));
	const byCase = new Map<number, z.infer<typeof ReplyFindingSchema>>();
	if (parsed.success) {
		for (const finding of parsed.data.findings) if (!byCase.has(finding.case)) byCase.set(finding.case, finding);
	}
	return batch.map((item, index) => {
		const finding = byCase.get(index + 1);
		if (!finding) {
			return {
				taskId: item.task.id,
				verdict: "unreviewed" as const,
				reasons: [parsed.success ? "the critic returned no finding for this case" : "the critic's reply was not the JSON it was asked for"],
			};
		}
		const reasons = cleanReasons(finding.reasons);
		const fix = finding.verdict === "repair" ? cleanFix(finding.fix) : undefined;
		if (finding.verdict === "repair" && !fix) {
			return { taskId: item.task.id, verdict: "repair" as const, reasons: reasons.length > 0 ? reasons : ["the critic asked for a repair but gave no usable fix"] };
		}
		if (finding.verdict !== "valid" && reasons.length === 0) {
			return { taskId: item.task.id, verdict: finding.verdict, reasons: ["the critic gave no reason"], ...(fix ? { fix } : {}) };
		}
		return { taskId: item.task.id, verdict: finding.verdict, reasons, ...(fix ? { fix } : {}) };
	});
}

function addSpend(total: EvaluatorModelMetrics, metrics: EvaluatorModelMetrics | undefined): void {
	if (!metrics) return;
	total.calls += metrics.calls;
	total.tokens += metrics.tokens;
	total.costUsd += metrics.costUsd;
}

/**
 * Ask the judge about every case, a batch at a time. A batch whose call fails
 * is `unreviewed` with the failure named: the critic's own outage is not a
 * verdict on a case, and the spend it cost is still counted.
 */
export async function critiqueCases(options: CritiqueCasesOptions): Promise<CritiqueCasesResult> {
	const size = Math.max(1, options.batchSize ?? CRITIC_BATCH_SIZE);
	const findings: CriticFinding[] = [];
	const spend: EvaluatorModelMetrics = { calls: 0, tokens: 0, costUsd: 0 };
	for (let start = 0; start < options.cases.length; start += size) {
		const batch = options.cases.slice(start, start + size);
		let text: string;
		try {
			const answered = await callEvaluatorModel({
				label: "case critic",
				model: options.judge,
				system: CRITIC_SYSTEM,
				user: criticUserPrompt(options, batch),
				sidecar: { dir: options.sidecarDir, stem: `critic-${Math.floor(start / size)}` },
				pinTemperature: true,
				abortMessage: "case critic aborted",
				...(options.signal ? { signal: options.signal } : {}),
			});
			addSpend(spend, answered.metrics);
			text = answered.text;
		} catch (error) {
			if (error instanceof EvaluatorModelError) addSpend(spend, error.metrics);
			options.signal?.throwIfAborted();
			const reason = `the critic could not be asked: ${redactTraceText(error instanceof Error ? error.message : String(error)).slice(0, 300)}`;
			findings.push(...batch.map((item) => ({ taskId: item.task.id, verdict: "unreviewed" as const, reasons: [reason] })));
			continue;
		}
		findings.push(...parseCriticReply(text, batch));
	}
	return { findings, spend };
}

export function criticCounts(findings: readonly CriticFinding[]): CriticCounts {
	const counts: CriticCounts = { valid: 0, repair: 0, invalid: 0, unreviewed: 0 };
	for (const finding of findings) counts[finding.verdict] += 1;
	return counts;
}

function receiptsRoot(stateRoot: string, projectId: string, create: boolean): string | null {
	return projectStateDir(stateRoot, projectId, "case-critic", { create, label: "case critic receipt" });
}

function receiptFile(root: string, subjectHash: string): string {
	return join(root, `${subjectHash.replace(/^sha256:/, "")}.json`);
}

/** The receipt for one subject, or null when the critic has not read it. */
export function loadCriticReceipt(stateRoot: string, projectId: string, subject: Pick<CriticSubject, "hash">): CriticReceipt | null {
	const root = receiptsRoot(stateRoot, projectId, false);
	if (!root) return null;
	const path = receiptFile(root, subject.hash);
	if (!existsSync(path)) return null;
	return readJsonArtifact(path, CriticReceiptSchema);
}

export function saveCriticReceipt(options: {
	stateRoot: string;
	projectId: string;
	subject: CriticSubject;
	/** Only the identity is recorded, so a receipt can be re-keyed from another receipt. */
	judge: Pick<TargetManifest["model"], "provider" | "id">;
	findings: readonly CriticFinding[];
	spend: EvaluatorModelMetrics;
	now?: () => string;
}): CriticReceipt {
	const root = receiptsRoot(options.stateRoot, options.projectId, true);
	if (!root) throw new Error(`project ${options.projectId} has no state directory for critic receipts`);
	const findings = [...options.findings].sort((left, right) => left.taskId.localeCompare(right.taskId));
	const body = {
		projectId: options.projectId,
		subject: options.subject,
		judge: { provider: options.judge.provider, id: options.judge.id },
		findings,
	};
	const receipt = CriticReceiptSchema.parse({
		schemaVersion: 1,
		kind: "case-critic",
		id: `critic-${hashValue(body).slice("sha256:".length)}`,
		...body,
		counts: criticCounts(findings),
		spend: { calls: options.spend.calls, tokens: options.spend.tokens, costUsd: options.spend.costUsd },
		createdAt: (options.now ?? (() => new Date().toISOString()))(),
	});
	writeJsonArtifact(receiptFile(root, options.subject.hash), CriticReceiptSchema, receipt);
	return receipt;
}
