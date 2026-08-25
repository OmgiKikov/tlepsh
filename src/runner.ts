import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	loadSkillsFromDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { ResolvedTarget, ResolvedTask, TargetManifest } from "./manifest.js";
import { hashFile, type RunRecord } from "./provenance.js";
import { traceToolErrors } from "./trace.js";

/**
 * The ONLY module that imports the Pi SDK for execution. Translates a resolved
 * target + task into an isolated Pi session and a durable run directory.
 * Pattern lifted from vendored packages/evals/src/pi-harness.ts.
 */

export interface RunTaskOptions {
	/** Root directory for run artifacts (e.g. <repo>/runs). */
	runsRoot: string;
	label: "baseline" | "candidate" | "solo";
	repetitionIndex: number;
	evalRunId: string | null;
	/** Target git sha this candidate improves (null for baseline/solo). */
	candidateOf: string | null;
	/**
	 * Targets run in an isolated copy by default. Builder runs opt into
	 * direct mode because their purpose is to patch the source repo.
	 */
	workspaceMode?: "isolated" | "direct";
}

export const FINAL_ANSWER_RECOVERY_PROMPT =
	"Сформируй итоговый ответ пользователю сейчас, используя уже полученные результаты инструментов. " +
	"Не вызывай инструменты. Выполни требования target harness к финальному ответу.";

function newRunId(): string {
	return `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function generateModelsJson(model: TargetManifest["model"]): Record<string, unknown> {
	const resolvedApiKey = process.env[model.apiKeyEnv];
	if (model.baseUrl.includes("openrouter.ai") && !resolvedApiKey) {
		throw new Error(`missing ${model.apiKeyEnv} for OpenRouter endpoint ${model.baseUrl}`);
	}
	const apiKey = resolvedApiKey ? `$${model.apiKeyEnv}` : "unset";
	const spec = model.spec;
	return {
		providers: {
			[model.provider]: {
				baseUrl: model.baseUrl,
				apiKey,
				api: model.api,
				models: [
					{
						id: model.id,
						name: model.id,
						reasoning: spec.reasoning,
						input: ["text"],
						cost: spec.cost,
						contextWindow: spec.contextWindow,
						maxTokens: spec.maxTokens,
						...(Object.keys(spec.compat).length > 0 ? { compat: spec.compat } : {}),
					},
				],
			},
		},
	};
}

function emptyMetrics(): RunRecord["metrics"] {
	return {
		tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		costUsd: 0,
		latencyMs: 0,
		toolCalls: 0,
		toolErrors: 0,
		recoveryAttempts: 0,
	};
}

function extractSessionError(content: string): string | undefined {
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed) as unknown;
		} catch {
			continue;
		}
		if (
			typeof parsed !== "object" || parsed === null ||
			typeof (parsed as { type?: unknown }).type !== "string" ||
			(parsed as { type?: string }).type !== "message"
		) {
			continue;
		}
		const message = (parsed as { message?: { role?: string; stopReason?: string; errorMessage?: string } }).message;
		if (message?.role === "assistant" && message.stopReason === "error" && message.errorMessage) {
			return message.errorMessage;
		}
	}
	return undefined;
}

function writeRunRecord(runDir: string, record: RunRecord): void {
	writeFileSync(join(runDir, "run.json"), `${JSON.stringify(record, null, "\t")}\n`);
}

/**
 * A live multi-turn agent session (the `ahde chat` companion). Same isolation
 * pattern as runTask, but no task/grading: the conversation IS the run.
 * Full transcript lands in the run dir as verbatim session.jsonl.
 */
export async function createInteractiveSession(options: {
	runsRoot: string;
	model: TargetManifest["model"];
	agentsMdContent: string;
	cwd: string;
}): Promise<{ session: AgentSession; sessionManager: SessionManager; runDir: string }> {
	const runId = `chat_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	const runDir = join(options.runsRoot, runId);
	const runtimeDir = join(runDir, "runtime");
	const agentDir = join(runtimeDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(runtimeDir, "models.json"),
		`${JSON.stringify(generateModelsJson(options.model), null, "\t")}\n`,
	);
	const modelRuntime = await ModelRuntime.create({
		modelsPath: join(runtimeDir, "models.json"),
		credentials: new InMemoryCredentialStore(),
		allowModelNetwork: false,
	});
	const selected = modelRuntime.getModel(options.model.provider, options.model.id);
	if (!selected) {
		throw new Error(`model ${options.model.provider}/${options.model.id} not found in generated models.json`);
	}
	const services = await createAgentSessionServices({
		cwd: options.cwd,
		agentDir,
		modelRuntime,
		settingsManager: SettingsManager.inMemory(),
		resourceLoaderOptions: {
			noContextFiles: true,
			agentsFilesOverride: () => ({ agentsFiles: [{ path: "AGENTS.md", content: options.agentsMdContent }] }),
			skillsOverride: (base) => ({ skills: [], diagnostics: base.diagnostics }),
		},
	});
	const sessionManager = SessionManager.create(options.cwd, runDir);
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager,
		model: selected,
		thinkingLevel: options.model.thinkingLevel,
	});
	return { session, sessionManager, runDir };
}

function prepareWorkspace(sourceDir: string, runDir: string, mode: RunTaskOptions["workspaceMode"]): string {
	if (mode === "direct") return sourceDir;
	const workspaceDir = join(runDir, "workspace");
	cpSync(sourceDir, workspaceDir, {
		recursive: true,
		preserveTimestamps: true,
		verbatimSymlinks: true,
		filter: (source) => !relative(sourceDir, source).split(sep).includes(".git"),
	});
	return workspaceDir;
}

/**
 * Run one task on the target harness. Never throws for task-level failures —
 * the returned RunRecord carries status "error" with a message instead.
 */
export async function runTask(target: ResolvedTarget, task: ResolvedTask, options: RunTaskOptions): Promise<RunRecord> {
	const runId = newRunId();
	const runDir = join(options.runsRoot, runId);
	const runtimeDir = join(runDir, "runtime");
	const agentDir = join(runtimeDir, "agent");
	mkdirSync(agentDir, { recursive: true });
	const executionCwd = prepareWorkspace(target.dir, runDir, options.workspaceMode);

	const model = target.manifest.model;
	const record: RunRecord = {
		schemaVersion: 1,
		runId,
		taskId: task.id,
		repetitionIndex: options.repetitionIndex,
		label: options.label,
		status: "running",
		error: null,
		startedAt: new Date().toISOString(),
		finishedAt: null,
		target: { id: target.manifest.id, gitSha: target.gitSha },
		runtime: { ...target.runtime },
		model: {
			provider: model.provider,
			id: model.id,
			thinkingLevel: model.thinkingLevel,
			params: model.params,
		},
		eval: {
			suiteId: target.manifest.evalSuite.id,
			suiteHash: target.suiteHash,
			dataset: target.manifest.evalSuite.dataset.replace(/\.jsonl$/, "").split("/").pop() ?? "dataset",
			datasetHash: target.datasetHash,
		},
		trace: { path: "session.jsonl", sessionId: null, sha256: null },
		metrics: emptyMetrics(),
		evalResults: null,
		parent: options.evalRunId
			? { evalRunId: options.evalRunId, candidateOf: options.candidateOf }
			: null,
	};

	// Crash-tolerant: provenance is on disk before any model call.
	writeRunRecord(runDir, record);

	const startedMs = Date.now();
	let session: AgentSession | undefined;
	let recoveryAttempts = 0;
	try {
		// Per-run isolation: fresh models.json + credentials + services.
		writeFileSync(join(runtimeDir, "models.json"), `${JSON.stringify(generateModelsJson(model), null, "\t")}\n`);
		const modelRuntime = await ModelRuntime.create({
			modelsPath: join(runtimeDir, "models.json"),
			credentials: new InMemoryCredentialStore(),
			allowModelNetwork: false,
		});
		const selected = modelRuntime.getModel(model.provider, model.id);
		if (!selected) {
			throw new Error(`model ${model.provider}/${model.id} not found in generated models.json`);
		}

		// Manifest-declared resources only: AGENTS.md and skills are injected
		// explicitly, context-file discovery is disabled — no walk-up escapes
		// the target repo.
		const agentsMdContent = readFileSync(resolve(executionCwd, target.manifest.instructions.agentsMd), "utf8");
		const skills = target.manifest.skills.flatMap((skillRel) =>
			loadSkillsFromDir({ dir: resolve(executionCwd, skillRel), source: "target" }).skills,
		);

		const services = await createAgentSessionServices({
			cwd: executionCwd,
			agentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory(),
			resourceLoaderOptions: {
				noContextFiles: true,
				agentsFilesOverride: () => ({ agentsFiles: [{ path: "AGENTS.md", content: agentsMdContent }] }),
				skillsOverride: (base) => ({ skills, diagnostics: base.diagnostics }),
			},
		});

		const sessionManager = SessionManager.create(executionCwd, runDir);
		session = (
			await createAgentSessionFromServices({
				services,
				sessionManager,
				model: selected,
				thinkingLevel: model.thinkingLevel,
			})
		).session;

		// Watchdog: prompt() has no deadline of its own.
		let timedOut = false;
		const watchdog = setTimeout(() => {
			timedOut = true;
			void session?.abort();
		}, model.timeoutMs);

		let finalAssistant;
		try {
			await session.prompt(task.input);
			if (timedOut) throw new Error(`run timed out after ${model.timeoutMs}ms`);

			finalAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
			const hasToolResults = session.messages.some((message) => message.role === "toolResult");
			if (finalAssistant?.stopReason === "stop" && !session.getLastAssistantText()?.trim() && hasToolResults) {
				recoveryAttempts = 1;
				const activeTools = session.agent.state.tools;
				session.agent.state.tools = [];
				try {
					await session.prompt(FINAL_ANSWER_RECOVERY_PROMPT);
				} finally {
					session.agent.state.tools = activeTools;
				}
				if (timedOut) throw new Error(`run timed out after ${model.timeoutMs}ms`);
				finalAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
			}
		} finally {
			clearTimeout(watchdog);
		}

		if (!finalAssistant) throw new Error("agent run completed without an assistant message");
		if (finalAssistant.stopReason !== "stop") {
			throw new Error(
				finalAssistant.errorMessage ?? `agent run ended with unexpected stop reason: ${finalAssistant.stopReason}`,
			);
		}
		if (!session.getLastAssistantText()?.trim()) {
			throw new Error("agent run produced no assistant text");
		}

		// Pin the session file to its canonical name inside the run dir.
		const sessionFile = sessionManager.getSessionFile();
		if (sessionFile) {
			renameSync(sessionFile, join(runDir, "session.jsonl"));
		}

		const stats = session.getSessionStats();
			const sessionContent = readFileSync(join(runDir, "session.jsonl"), "utf8");
			const sessionError = extractSessionError(sessionContent);
			if (sessionError) throw new Error(sessionError);
			const toolErrors = traceToolErrors(
				// parse lazily through trace.ts to keep a single format owner
				(await import("./trace.js")).parseSessionJsonl(sessionContent),
		);

		record.status = "completed";
		record.finishedAt = new Date().toISOString();
		record.trace = {
			path: "session.jsonl",
			sessionId: stats.sessionId,
			sha256: hashFile(sessionContent),
		};
		record.metrics = {
			tokens: {
				input: stats.tokens.input,
				output: stats.tokens.output,
				cacheRead: stats.tokens.cacheRead,
				cacheWrite: stats.tokens.cacheWrite,
				total: stats.tokens.total,
			},
			costUsd: stats.cost,
			latencyMs: Date.now() - startedMs,
			toolCalls: stats.toolCalls,
			toolErrors,
			recoveryAttempts,
		};
	} catch (error) {
		record.status = "error";
		record.finishedAt = new Date().toISOString();
		record.error = error instanceof Error ? error.message : String(error);
		record.metrics = { ...record.metrics, latencyMs: Date.now() - startedMs, recoveryAttempts };
		// Best effort: keep whatever trace survived.
		try {
			const files = execFileSync("find", [runDir, "-name", "*.jsonl", "-maxdepth", "1"], { encoding: "utf8" })
				.trim()
				.split("\n")
				.filter(Boolean);
			const sessionFile = files[0];
			if (sessionFile && sessionFile.endsWith(".jsonl")) {
				if (!sessionFile.endsWith("session.jsonl")) renameSync(sessionFile, join(runDir, "session.jsonl"));
				const content = readFileSync(join(runDir, "session.jsonl"), "utf8");
				record.trace = { path: "session.jsonl", sessionId: null, sha256: hashFile(content) };
			}
		} catch {
			// no trace survived
		}
	} finally {
		try {
			session?.dispose();
		} catch {
			// dispose during error paths is best-effort
		}
	}

	writeRunRecord(runDir, record);
	return record;
}
