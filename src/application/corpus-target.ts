import {
	listCorpora,
	loadCorpus,
	type CorpusVisibility,
	type LoadedCorpus,
} from "../corpus.js";
import type { EvalRunRecord } from "../eval.js";
import {
	assertEvaluatorsConfigured,
	executionKindOf,
	graderNeedsExpected,
	type GraderSpec,
	hasReferenceAnswer,
	judgeMeasurementIdentity,
	simulatedUserMeasurementIdentity,
	type ResolvedTarget,
	type TargetManifest,
	worldExpectationGraders,
} from "../manifest.js";
import { hashValue } from "../provenance.js";
import { knowledgeBaseDeclared } from "../target/kb-tool.js";
import { t } from "../i18n.js";

function cloneGrader(grader: GraderSpec): GraderSpec {
	return { ...grader };
}

export function corpusDatasetLabel(visibility: CorpusVisibility, corpusId: string): string {
	return `${visibility}-${corpusId}`;
}

export interface EvalSurfaceIdentity {
	dataset: string;
	datasetHash: string;
	suiteHash: string;
}

export function targetEvalSurface(target: ResolvedTarget): EvalSurfaceIdentity {
	return {
		dataset: target.manifest.evalSuite.dataset.replace(/\.jsonl$/, "").split("/").pop() ?? "dataset",
		datasetHash: target.datasetHash,
		suiteHash: target.suiteHash,
	};
}

export function evalSurfaceMatches(
	target: ResolvedTarget,
	evidence: EvalSurfaceIdentity,
): boolean {
	const actual = targetEvalSurface(target);
	return (
		actual.dataset === evidence.dataset &&
		actual.datasetHash === evidence.datasetHash &&
		actual.suiteHash === evidence.suiteHash
	);
}

export function assertEvalSurfaceMatches(
	target: ResolvedTarget,
	evidence: EvalSurfaceIdentity,
	label: string,
): void {
	if (evalSurfaceMatches(target, evidence)) return;
	const actual = targetEvalSurface(target);
	throw new Error(
		`${label} does not match the exact evaluation surface: ` +
			`expected ${evidence.dataset}/${evidence.datasetHash}/${evidence.suiteHash}, ` +
			`got ${actual.dataset}/${actual.datasetHash}/${actual.suiteHash}`,
	);
}

/** Replace only the resolved evaluation surface; corpus content remains in memory. */
function targetWithCorpus(
	target: ResolvedTarget,
	corpus: LoadedCorpus,
	visibility: CorpusVisibility,
): ResolvedTarget {
	if (corpus.metadata.visibility !== visibility) {
		throw new Error(
			`${visibility} evaluation requires a ${visibility} corpus, got ${corpus.metadata.visibility} (${corpus.metadata.id})`,
		);
	}

	const tasks = corpus.tasks.map((task) => {
		const graders = task.graders.map(cloneGrader);
		for (const grader of graders) {
			if (grader.type !== "output_matches") continue;
			try {
				new RegExp(grader.pattern);
			} catch (error) {
				throw new Error(
					`${visibility} corpus ${corpus.metadata.id} task ${task.id} has an invalid output_matches regex: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		for (const grader of graders) {
			if (graderNeedsExpected(grader) && !hasReferenceAnswer(task)) {
				throw new Error(
					`${visibility} corpus ${corpus.metadata.id} task ${task.id} pairs a ${grader.type} grader with a case that has no "expected" reference answer`,
				);
			}
		}
		return {
			id: task.id,
			input: task.input,
			// Reference answers and dialogue history travel with the corpus case:
			// the runner seeds the turns and the graders compare with `expected`.
			...(task.expected !== undefined ? { expected: task.expected } : {}),
			...(task.messages !== undefined ? { messages: task.messages } : {}),
			...(task.simulatedUser !== undefined ? { simulatedUser: task.simulatedUser } : {}),
			// The world a published case happens in travels with it: the runner
			// writes it per run and its expectations are scored like any grader.
			...(task.world !== undefined ? { world: task.world } : {}),
			...(task.metadata !== undefined ? { metadata: task.metadata } : {}),
			graders,
			// The same rule `resolveTaskGraders` applies to a manifest dataset: an
			// expectation beside the state is a grader by the time anything scores.
			effectiveGraders: [...graders.map(cloneGrader), ...worldExpectationGraders(task)],
		};
	});

	// Fail closed, and say which cases: a published corpus can grade with a judge
	// and carry conversations, and running either without its evaluator would
	// measure something that did not happen. One typed refusal for both roles, so
	// the host can put it to the operator in their own language instead of
	// handing them a sentence about a manifest field.
	assertEvaluatorsConfigured(tasks, target.manifest.evalSuite);

	return {
		...target,
		manifest: {
			...target.manifest,
			evalSuite: {
				...target.manifest.evalSuite,
				// Identifier only, never a corpus path. runSuite consumes resolved tasks.
				dataset: `${corpusDatasetLabel(visibility, corpus.metadata.id)}.jsonl`,
			},
		},
		tasks,
		// CorpusMetadata.hash is the canonical hash verified by loadCorpus.
		datasetHash: corpus.metadata.hash,
		// Identity as well as content participates in reuse provenance. A
		// same-content corpus imported under another snapshot id is not exact.
		suiteHash: hashValue({
			schemaVersion: 1,
			corpus: { id: corpus.metadata.id, hash: corpus.metadata.hash, visibility },
			effectiveGraders: "explicit-per-task",
			// Same measurement-only view the manifest formula hashes: a promotion
			// policy is not a grading input, so toggling `requireCalibration`
			// leaves every published-corpus eval comparable.
			judge: judgeMeasurementIdentity(target.manifest.evalSuite.judge),
			// Undefined — and so canonically absent — for every suite without one,
			// which keeps every published-corpus suite hash minted before simulated
			// users existed exactly what it was.
			simulatedUser: simulatedUserMeasurementIdentity(target.manifest.evalSuite.simulatedUser),
		}),
		suiteIdentity: "corpus",
	};
}

export function targetWithDevelopmentCorpus(target: ResolvedTarget, corpus: LoadedCorpus): ResolvedTarget {
	if (corpus.metadata.visibility !== "development") {
		throw new Error(
			`development evaluation requires a development corpus, got ${corpus.metadata.visibility} (${corpus.metadata.id})`,
		);
	}
	return targetWithCorpus(target, corpus, "development");
}

export function targetWithSealedCorpus(target: ResolvedTarget, corpus: LoadedCorpus): ResolvedTarget {
	if (corpus.metadata.visibility !== "sealed") {
		throw new Error(
			`candidate holdout requires a sealed corpus, got ${corpus.metadata.visibility} (${corpus.metadata.id})`,
		);
	}
	return targetWithCorpus(target, corpus, "sealed");
}

/**
 * Reconstruct the exact development target used by an immutable eval. The
 * manifest dataset wins only on a full dataset/hash/suite match; otherwise a
 * published development corpus must match both its canonical label and hash.
 */
export function resolveDevelopmentTargetForEval(options: {
	target: ResolvedTarget;
	evalRun: Pick<EvalRunRecord, "target" | "dataset" | "datasetHash" | "suiteHash">;
	stateRoot: string;
	projectId: string;
}): { target: ResolvedTarget; corpus: LoadedCorpus | null } {
	const { target, evalRun } = options;
	if (target.manifest.id !== evalRun.target.id || target.gitSha !== evalRun.target.gitSha) {
		throw new Error(
			`development evidence belongs to ${evalRun.target.id}@${evalRun.target.gitSha}, ` +
				`not ${target.manifest.id}@${target.gitSha}`,
		);
	}
	if (evalSurfaceMatches(target, evalRun)) return { target, corpus: null };

	const matches = listCorpora({ stateRoot: options.stateRoot, projectId: options.projectId })
		.filter((metadata) => (
			metadata.visibility === "development" &&
			corpusDatasetLabel("development", metadata.id) === evalRun.dataset &&
			metadata.hash === evalRun.datasetHash
		));
	if (matches.length !== 1) {
		throw new Error(
			"cannot reconstruct the exact development evaluation surface from the target manifest or " +
				`a published corpus: ${evalRun.dataset}/${evalRun.datasetHash}/${evalRun.suiteHash}`,
		);
	}
	const corpus = loadCorpus({
		stateRoot: options.stateRoot,
		projectId: options.projectId,
		corpusId: matches[0]!.id,
	});
	const resolved = targetWithDevelopmentCorpus(target, corpus);
	assertEvalSurfaceMatches(resolved, evalRun, "published development corpus");
	return { target: resolved, corpus };
}

/**
 * Reconstruct the exact case set an immutable eval scored, so its recorded
 * traces can be re-graded.
 *
 * Unlike {@link resolveDevelopmentTargetForEval} this deliberately ignores the
 * Target revision and the recorded suite hash: changing the graders is the whole
 * point of a regrade, and editing `evals/graders.yaml` already makes the
 * checkout dirty. Only the cases themselves — dataset label and dataset hash —
 * must be the exact ones the recorded traces answered.
 */
export function resolveScoredCasesForEval(options: {
	target: ResolvedTarget;
	evalRun: Pick<EvalRunRecord, "target" | "dataset" | "datasetHash">;
	stateRoot: string;
	projectId: string;
}): { target: ResolvedTarget; corpus: LoadedCorpus | null } {
	const { target, evalRun } = options;
	if (target.manifest.id !== evalRun.target.id) {
		throw new Error(`evidence belongs to target ${evalRun.target.id}, not ${target.manifest.id}`);
	}
	const surface = targetEvalSurface(target);
	if (surface.dataset === evalRun.dataset && surface.datasetHash === evalRun.datasetHash) {
		return { target, corpus: null };
	}
	const matches = listCorpora({ stateRoot: options.stateRoot, projectId: options.projectId })
		.filter((metadata) => (
			metadata.visibility === "development" &&
			corpusDatasetLabel("development", metadata.id) === evalRun.dataset &&
			metadata.hash === evalRun.datasetHash
		));
	if (matches.length !== 1) {
		throw new Error(
			"cannot reconstruct the exact scored cases from the target manifest or a published corpus: " +
				`${evalRun.dataset}/${evalRun.datasetHash}`,
		);
	}
	const corpus = loadCorpus({
		stateRoot: options.stateRoot,
		projectId: options.projectId,
		corpusId: matches[0]!.id,
	});
	const resolved = targetWithDevelopmentCorpus(target, corpus);
	if (resolved.datasetHash !== evalRun.datasetHash) {
		throw new Error(
			`published development corpus ${corpus.metadata.id} does not carry the scored cases: ` +
				`expected ${evalRun.datasetHash}, got ${resolved.datasetHash}`,
		);
	}
	return { target: resolved, corpus };
}

/**
 * Reject graders the current Target could never run *before* a draft or a
 * publication is persisted. Composition (`targetWithDevelopmentCorpus`) makes
 * the same checks later; this earlier, model-readable failure keeps a bad
 * regex or an unsupported judge grader from blocking a reviewed basket.
 */
/**
 * A declared tool, as the draft checks read it: its name and the parameter
 * names its JSON-Schema `parameters` block actually declares.
 *
 * `ResolvedTargetTool["descriptor"]` satisfies it structurally, so a caller
 * hands over `target.tools.map((tool) => tool.descriptor)` and nothing has to
 * be re-derived.
 */
export interface DeclaredToolShape {
	name: string;
	parameters: Record<string, unknown>;
	permissions?: { environment?: readonly string[] } | undefined;
}

/** An identifier, which is what a parameter name looks like and a value does not. */
const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The parameter names an `argsContains` claims, or none.
 *
 * `tool_called.argsContains` is a substring test over the serialized call, so
 * most of what may be written there is a VALUE and none of the host's
 * business. Exactly two shapes name parameters and can be checked: a bare
 * identifier, and a JSON object whose keys are the arguments — which is the
 * shape session 7 wrote (`{"contractId":"12345"}` against a tool whose only
 * parameter is `account`). Anything else is left alone.
 */
function namedParameters(argsContains: string): string[] {
	const text = argsContains.trim();
	if (PARAMETER_NAME.test(text)) return [text];
	if (!text.startsWith("{")) return [];
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
		return Object.keys(parsed as Record<string, unknown>).filter((key) => PARAMETER_NAME.test(key));
	} catch {
		return [];
	}
}

/** The parameter names a descriptor's JSON Schema declares, in schema order. */
function declaredParameterNames(tool: DeclaredToolShape): string[] {
	const properties = (tool.parameters as { properties?: unknown }).properties;
	if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return [];
	return Object.keys(properties as Record<string, unknown>);
}

/**
 * Whether this tool reads the case's world.
 *
 * Two ways to know, and both are declarations rather than guesses: the broker
 * hands `AHDE_WORLD` to a tool that asks for it, and a command Target reaches
 * every one of its tools through that same broker, so for a command agent any
 * declared tool may consult the world.
 */
function toolConsultsWorld(tool: DeclaredToolShape, commandAgent: boolean): boolean {
	if (commandAgent) return true;
	return (tool.permissions?.environment ?? []).includes("AHDE_WORLD");
}

/**
 * What the two draft checks need from the committed Target: its declared
 * tools, and whether it is a command agent (every one of whose tools reaches
 * the world through the broker).
 */
export function targetToolContext(
	target: Pick<ResolvedTarget, "tools" | "manifest">,
): { tools: DeclaredToolShape[]; commandAgent: boolean } {
	return {
		tools: target.tools.map((tool) => tool.descriptor),
		commandAgent: executionKindOf(target.manifest.execution) === "command",
	};
}

export function assertGradersRunnable(
	tasks: readonly {
		expected?: string | undefined;
		graders?: readonly GraderSpec[];
		simulatedUser?: unknown;
	}[],
	// `data` is optional so a caller holding only the eval suite still type-checks;
	// when it is absent the knowledge-base check simply has nothing to say.
	manifest: Pick<TargetManifest, "evalSuite"> & Partial<Pick<TargetManifest, "data">>,
	label = "corpus draft",
	options: {
		/**
		 * A missing evaluator is not this draft's problem. Authoring a case that
		 * needs a judge — or a case that is a conversation — is how the host learns
		 * one is needed: `start-testing` then pre-fills an independent model for
		 * both roles inside the one dialog that publishes and runs the basket.
		 * Publication and composition stay strict, so nothing ever runs against an
		 * evaluator that does not exist.
		 */
		evaluatorsChosenLater?: boolean;
		/**
		 * The Target's declared tools. Without them a `tool_called` grader can
		 * only be checked for shape; with them it can be checked against the tool
		 * it actually names.
		 */
		tools?: readonly DeclaredToolShape[];
	} = {},
): void {
	const problems: string[] = [];
	const declared = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
	tasks.forEach((task, taskIndex) => {
		if (task.simulatedUser !== undefined && !manifest.evalSuite.simulatedUser && options.evaluatorsChosenLater !== true) {
			problems.push(
				`task ${taskIndex + 1}: simulated-user cases need a user model configured in the Target manifest ` +
				"(evalSuite.simulatedUser), and this Target has none. Ask the operator to configure the simulated-user model first.",
			);
		}
		(task.graders ?? []).forEach((grader, graderIndex) => {
			const where = `task ${taskIndex + 1} grader ${graderIndex + 1}`;
			if (grader.type === "output_matches") {
				try {
					new RegExp(grader.pattern);
				} catch (error) {
					problems.push(
						`${where}: output_matches pattern ${JSON.stringify(grader.pattern)} is not a valid JavaScript regular expression` +
						` (${error instanceof Error ? error.message : String(error)}). Inline flags such as (?i) or (?s) are not supported;` +
						" use character classes like [Цц] or a simpler pattern.",
					);
				}
			}
			if (grader.type === "judge" && !manifest.evalSuite.judge && options.evaluatorsChosenLater !== true) {
				problems.push(
					`${where}: judge graders need a judge model configured in the Target manifest (evalSuite.judge), and this Target has none.` +
					" Use output_contains, output_matches, or tool_called instead, or ask the operator to configure a judge model first.",
				);
			}
			if (grader.type === "cites_source" && manifest.data !== undefined && !knowledgeBaseDeclared(manifest.data)) {
				problems.push(
					`${where}: cites_source graders read the Target's knowledge base, and this Target declares no data/kb.` +
					" Declare it in the manifest's data list, or use similarity or output_contains instead.",
				);
			}
			if (graderNeedsExpected(grader) && !hasReferenceAnswer(task)) {
				problems.push(
					`${where}: ${grader.type} graders compare the answer with the case's reference answer, and this case has no "expected".` +
					" Give the case an expected answer, or use output_contains, output_matches, or tool_called instead.",
				);
			}
			// Session 7: three cases asked `argsContains: "contractId"` of a tool
			// whose one parameter is `account`. The checks could not fire under any
			// circumstance, and nothing said so — not at draft, not at publication,
			// not on the run. A bare identifier is a parameter name and can be
			// checked against the descriptor; anything else may be a value the
			// agent passes, and stays the operator's business.
			if (grader.type === "tool_called" && grader.argsContains !== undefined) {
				const tool = declared.get(grader.tool);
				const names = tool ? declaredParameterNames(tool) : [];
				const unknown = tool && names.length > 0
					? namedParameters(grader.argsContains).find((name) => !names.includes(name))
					: undefined;
				if (unknown !== undefined) {
					problems.push(`${where}: ${t("draft.tool-parameter-unknown", {
						tool: grader.tool,
						parameter: unknown,
						parameters: names.join(", "),
					})}`);
				}
			}
		});
	});
	if (problems.length > 0) {
		throw new Error(`${label} cannot run on the current Target:\n- ${problems.slice(0, 8).join("\n- ")}`);
	}
}

/**
 * Cases that ask a tool to read the world and then hand it no world.
 *
 * Session 7 wrote three of them: the grader required `get_account`, the tool
 * answered `{"error":"нет данных о мире прогона"}`, and the case was
 * unpassable by construction — nothing said so at authoring, at publication or
 * on the run. This is a warning and not a refusal on purpose: a case may
 * legitimately require a tool call and grade only the call, and the operator
 * is the one who knows which.
 */
export function draftWorldWarnings(
	tasks: readonly {
		graders?: readonly GraderSpec[];
		world?: unknown;
		metadata?: Record<string, string> | undefined;
	}[],
	options: {
		tools?: readonly DeclaredToolShape[];
		/**
		 * A command Target reaches every declared tool through the same broker
		 * that hands the world over, so any of its tools may consult one.
		 */
		commandAgent?: boolean;
	} = {},
): string[] {
	const declared = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
	const warnings: string[] = [];
	tasks.forEach((task, index) => {
		if (task.world !== undefined && task.world !== null) return;
		const worldReader = (task.graders ?? []).find((grader) =>
			grader.type === "tool_called" &&
			(() => {
				const tool = declared.get(grader.tool);
				return tool !== undefined && toolConsultsWorld(tool, options.commandAgent === true);
			})());
		if (!worldReader || worldReader.type !== "tool_called") return;
		const named = task.metadata?.name ?? task.metadata?.id ?? "";
		warnings.push(t("draft.world-missing", {
			case: named.trim().length > 0 ? named : `#${index + 1}`,
			tool: worldReader.tool,
		}));
	});
	return warnings;
}
