import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
import type { ResolvedTarget, ResolvedTask } from "./manifest.js";
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
}

function newRunId(): string {
	return `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function generateModelsJson(target: ResolvedTarget): Record<string, unknown> {
	const model = target.manifest.model;
	const apiKey = process.env[model.apiKeyEnv] ? `$${model.apiKeyEnv}` : "unset";
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
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 131072,
						maxTokens: 8192,
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
	};
}

function writeRunRecord(runDir: string, record: RunRecord): void {
	writeFileSync(join(runDir, "run.json"), `${JSON.stringify(record, null, "\t")}\n`);
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
	try {
		// Per-run isolation: fresh models.json + credentials + services.
		writeFileSync(join(runtimeDir, "models.json"), `${JSON.stringify(generateModelsJson(target), null, "\t")}\n`);
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
		const agentsMdContent = readFileSync(resolve(target.dir, target.manifest.instructions.agentsMd), "utf8");
		const skills = target.manifest.skills.flatMap((skillRel) =>
			loadSkillsFromDir({ dir: resolve(target.dir, skillRel), source: "target" }).skills,
		);

		const services = await createAgentSessionServices({
			cwd: target.dir,
			agentDir,
			modelRuntime,
			settingsManager: SettingsManager.inMemory(),
			resourceLoaderOptions: {
				noContextFiles: true,
				agentsFilesOverride: () => ({ agentsFiles: [{ path: "AGENTS.md", content: agentsMdContent }] }),
				skillsOverride: (base) => ({ skills, diagnostics: base.diagnostics }),
			},
		});

		const sessionManager = SessionManager.create(target.dir, runDir);
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

		try {
			await session.prompt(task.input);
		} finally {
			clearTimeout(watchdog);
		}
		if (timedOut) throw new Error(`run timed out after ${model.timeoutMs}ms`);

		// Pin the session file to its canonical name inside the run dir.
		const sessionFile = sessionManager.getSessionFile();
		if (sessionFile) {
			renameSync(sessionFile, join(runDir, "session.jsonl"));
		}

		const stats = session.getSessionStats();
		const sessionContent = readFileSync(join(runDir, "session.jsonl"), "utf8");
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
		};
	} catch (error) {
		record.status = "error";
		record.finishedAt = new Date().toISOString();
		record.error = error instanceof Error ? error.message : String(error);
		record.metrics = { ...record.metrics, latencyMs: Date.now() - startedMs };
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
