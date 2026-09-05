import { createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { main as piMain, SessionManager, VERSION as PI_VERSION, type ExtensionFactory, type MainOptions } from "@earendil-works/pi-coding-agent";
import { commitLocalArtifactIgnores, ensureLocalArtifactIgnores } from "../application/store-hygiene.js";
import { writeTextArtifact } from "../storage/artifacts.js";
import { loadTarget } from "../manifest.js";
import { runInteractiveTarget } from "../target/interactive.js";
import { assertTargetReadyToRun } from "../target/readiness.js";
import { createAhdeBuilderExtension, type BuilderExtensionDependencies } from "./extension.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// The persona is one file. The four "workflow skills" it used to inline were
// its own typical loop restated, and the live sessions showed the two copies
// drifting apart (the skill still sent the operator to a terminal for the
// judge check the persona had already moved into the conversation).
const BUILDER_SKILLS: readonly string[] = [];
/** Per-project Builder files worth carrying into the user-level home. */
const MIGRATED_BUILDER_CONFIG_FILES = ["auth.json", "models.json"] as const;
export const AHDE_BUILDER_BUILTIN_COMMANDS = [
	"login",
	"logout",
	"model",
	"thinking",
	"compact",
	"new",
	"resume",
	"session",
	"name",
	"copy",
	"hotkeys",
	"quit",
] as const;
export const AHDE_BUILDER_PREFERRED_EXTENSION_COMMANDS = ["help", "status"] as const;

/** new: fresh conversation · continue: the most recent one · resume: the private picker. */
export type BuilderSessionMode = "new" | "continue" | "resume";

export interface BuilderAssets {
	root: string;
	systemPromptPath: string;
	systemPrompt: string;
	skillPaths: string[];
	targetTemplateDir: string;
}

export interface LaunchBuilderPiOptions {
	projectDir?: string;
	stateRoot?: string;
	runsRoot?: string;
	projectId?: string;
	/** User-level Builder credentials and Pi settings; see resolveBuilderHome. */
	builderHome?: string;
	packageRoot?: string;
	piArgs?: string[];
	/** Omitted: continue this project's last conversation, or start its first. */
	sessionMode?: BuilderSessionMode;
	dependencies?: Partial<BuilderExtensionDependencies>;
	main?: (args: string[], options?: MainOptions) => Promise<void>;
	extensionFactory?: ExtensionFactory;
	/** Injectable isolated Runtime Pi launcher for host-loop tests. */
	targetRunner?: typeof runInteractiveTarget;
}

function assertRegularFile(path: string, label: string): void {
	if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
	const entry = lstatSync(path);
	if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file: ${path}`);
}

function ensurePrivateDirectory(path: string): string {
	const absolute = resolve(path);
	if (!existsSync(absolute)) mkdirSync(absolute, { recursive: true, mode: 0o700 });
	const entry = lstatSync(absolute);
	if (!entry.isDirectory() || entry.isSymbolicLink()) {
		throw new Error(`Builder private path must be a regular non-symlink directory: ${absolute}`);
	}
	return realpathSync(absolute);
}

function pathExists(path: string): boolean {
	return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function isRegularFile(path: string): boolean {
	const entry = lstatSync(path, { throwIfNoEntry: false });
	return entry !== undefined && entry.isFile() && !entry.isSymbolicLink();
}

/**
 * Builder credentials and Pi settings live in one user-level home, like
 * ~/.codex and ~/.claude, so a single /login serves every project. Builder
 * sessions stay per project under the state root.
 */
export function resolveBuilderHome(explicit?: string): string {
	if (explicit) return resolve(explicit);
	const configured = process.env.AHDE_HOME;
	if (configured && configured.trim() !== "") return resolve(configured, "builder-pi");
	return join(homedir(), ".ahde", "builder-pi");
}

/**
 * Carry per-project Builder credentials into the user-level home once. A
 * user-level file is never replaced, so the first migrated project wins and
 * later projects simply reuse it.
 */
function migrateLegacyBuilderConfig(legacyConfigDir: string, agentDir: string): void {
	if (pathExists(join(agentDir, "auth.json")) || !isRegularFile(join(legacyConfigDir, "auth.json"))) return;
	for (const name of MIGRATED_BUILDER_CONFIG_FILES) {
		const source = join(legacyConfigDir, name);
		const destination = join(agentDir, name);
		if (!isRegularFile(source) || pathExists(destination)) continue;
		try {
			writeTextArtifact(destination, readFileSync(source, "utf8"), { immutable: true, mode: 0o600 });
		} catch (error) {
			// A concurrent launch published the same file first; the user-level copy wins.
			if (pathExists(destination)) continue;
			throw error;
		}
	}
}

/**
 * Pi is an embedded engine here, so its own startup chatter stays out of the
 * Builder. quietStartup drops the model-scope banner; hideThinkingBlock keeps
 * the Builder's reasoning off the transcript. lastChangelogVersion is
 * pinned to the vendored Pi version: a missing key already shows nothing (Pi
 * records it as a fresh install and reports that install to pi.dev), but after
 * an AHDE upgrade Pi would render its own "What's New" for every entry newer
 * than the recorded version. Other keys, including an explicit
 * quietStartup: false, are preserved; an unparseable file is left alone.
 */
function seedBuilderSettings(agentDir: string): void {
	const path = join(agentDir, "settings.json");
	let settings: Record<string, unknown> = {};
	if (pathExists(path)) {
		if (!isRegularFile(path)) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			return;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
		settings = parsed as Record<string, unknown>;
	}
	let changed = false;
	if (!("quietStartup" in settings)) {
		settings = { ...settings, quietStartup: true };
		changed = true;
	}
	// The Builder's reasoning is not for the operator: the persona talks about
	// their agent, and a reasoning model's stream (live session 8, kimi) wrapped
	// one character per line for minutes. An explicit false is kept.
	if (!("hideThinkingBlock" in settings)) {
		settings = { ...settings, hideThinkingBlock: true };
		changed = true;
	}
	if (settings.lastChangelogVersion !== PI_VERSION) {
		settings = { ...settings, lastChangelogVersion: PI_VERSION };
		changed = true;
	}
	if (!changed) return;
	writeTextArtifact(path, `${JSON.stringify(settings, null, "\t")}\n`, { mode: 0o600 });
}

export function resolveBuilderAssets(packageRoot = PACKAGE_ROOT): BuilderAssets {
	const root = resolve(packageRoot, "builders", "ahde");
	if (!existsSync(root) || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
		throw new Error(`AHDE Builder assets are missing: ${root}`);
	}
	const systemPromptPath = join(root, "AGENTS.md");
	assertRegularFile(systemPromptPath, "Builder system prompt");
	const skillPaths = BUILDER_SKILLS.map((name) => {
		const path = join(root, "skills", name, "SKILL.md");
		assertRegularFile(path, `Builder skill ${name}`);
		return path;
	});
	const targetTemplateDir = join(resolve(packageRoot), "templates", "basic-agent");
	if (!existsSync(targetTemplateDir)) throw new Error(`Builder target template is missing: ${targetTemplateDir}`);
	const templateEntry = lstatSync(targetTemplateDir);
	if (!templateEntry.isDirectory() || templateEntry.isSymbolicLink()) {
		throw new Error(`Builder target template must be a regular non-symlink directory: ${targetTemplateDir}`);
	}
	assertRegularFile(join(targetTemplateDir, "manifest.yaml"), "Builder target template manifest");
	return {
		root,
		systemPromptPath,
		systemPrompt: composeBuilderSystemPrompt(readFileSync(systemPromptPath, "utf8"), skillPaths),
		skillPaths,
		targetTemplateDir,
	};
}

/**
 * Pi only lists skills in the system prompt when the model has a `read` tool
 * to open them, and the Builder deliberately has none. The packaged workflow
 * skills are therefore inlined here, so the model sees them without any file
 * access; `--skill` stays registered for hosts that do expose reading.
 */
export function composeBuilderSystemPrompt(agentsMd: string, skillPaths: readonly string[]): string {
	const sections = skillPaths.map((path) => {
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

const FORBIDDEN_FLAGS = new Set([
	"--extension", "-e",
	"--skill",
	"--prompt-template",
	"--system-prompt",
	"--append-system-prompt",
	"--session-dir",
	"--tools", "-t",
	"--exclude-tools", "-xt",
	"--no-tools", "-nt",
	"--session",
	"--session-id",
	"--continue", "-c",
	"--resume", "-r",
	"--fork",
	"--models",
	"--export",
	"--approve", "-a",
	"--no-approve", "-na",
]);

/** Prevent caller arguments from reopening ambient resources or replacing the trusted prompt. */
export function validateBuilderPiArgs(args: readonly string[]): string[] {
	for (const argument of args) {
		const flag = argument.split("=", 1)[0] ?? argument;
		if (FORBIDDEN_FLAGS.has(flag)) throw new Error(`Builder Pi argument is controlled by AHDE and cannot be overridden: ${flag}`);
		if (argument.startsWith("@")) throw new Error("Builder Pi file arguments are disabled; use bounded AHDE read tools");
	}
	return [...args];
}

/**
 * Native discovery owns project identity. AHDE adds one guard:
 * discovery must not quietly skip unreadable history and start afresh. This
 * reads only; the native runtime remains the sole session writer.
 */
async function resolveBuilderSession(
	projectDir: string,
	sessionDir: string,
	requested?: BuilderSessionMode,
): Promise<{ mode: BuilderSessionMode; path?: string }> {
	if (requested === "new" || requested === "resume") return { mode: requested };
	const paths = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl"))
		.map((name) => join(sessionDir, name));
	for (const path of paths) assertRegularFile(path, "Builder conversation");
	const sessions = await SessionManager.listAll(sessionDir);
	const discovered = new Set(sessions.map((session) => resolve(session.path)));
	const unreadable = paths.find((path) => !discovered.has(resolve(path)));
	if (unreadable) {
		throw new Error(`Builder conversation is unreadable: ${unreadable}. It was left unchanged. Use ahde resume to choose another conversation, or ahde builder-pi to start a new one.`);
	}
	const ownPaths = new Set(sessions.filter((session) => resolve(session.cwd) === resolve(projectDir))
		.map((session) => resolve(session.path)));
	// Native --continue orders by file mtime, not the message activity time
	// used by listAll. Keep readdir order for equal mtimes, just as native does.
	const latest = paths.filter((path) => ownPaths.has(resolve(path)))
		.map((path) => ({ path, modified: lstatSync(path).mtimeMs }))
		.sort((a, b) => b.modified - a.modified)[0];
	if (latest) {
		// Native parsing tolerates broken JSONL entries. Before automatic resume,
		// require readable entries so a partial write cannot silently drop intent.
		const stream = createReadStream(latest.path, { encoding: "utf8" });
		const lines = createInterface({ input: stream, crlfDelay: Infinity });
		try {
			for await (const line of lines) {
				if (!line.trim()) continue;
				const entry: unknown = JSON.parse(line);
				if (!entry || typeof entry !== "object" || !("type" in entry) || typeof entry.type !== "string") {
					throw new Error("invalid conversation entry");
				}
			}
		} catch (error) {
			throw new Error(`Builder conversation is unreadable: ${latest.path}. It was left unchanged. Use ahde resume to choose another conversation, or ahde builder-pi to start a new one.`, { cause: error });
		} finally {
			lines.close();
			stream.destroy();
		}
	}
	return { mode: requested ?? (latest ? "continue" : "new"), ...(latest ? { path: latest.path } : {}) };
}

export async function resolveBuilderSessionMode(
	projectDir: string,
	sessionDir: string,
	requested?: BuilderSessionMode,
): Promise<BuilderSessionMode> {
	return (await resolveBuilderSession(projectDir, sessionDir, requested)).mode;
}

export function buildBuilderPiArgs(input: {
	assets: BuilderAssets;
	sessionDir: string;
	piArgs?: readonly string[];
	sessionMode?: BuilderSessionMode;
	/** Host-selected, validated private history. Never accepted from piArgs. */
	sessionPath?: string;
}): string[] {
	return [
		"--no-builtin-tools",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
		"--no-prompt-templates",
		"--no-themes",
		"--session-dir", input.sessionDir,
		"--system-prompt", input.assets.systemPrompt,
		...input.assets.skillPaths.flatMap((path) => ["--skill", path]),
		...(input.sessionMode === "resume" ? ["--resume"] : input.sessionMode === "continue"
			? input.sessionPath ? ["--session", input.sessionPath] : ["--continue"] : []),
		...validateBuilderPiArgs(input.piArgs ?? []),
	];
}

/** Launch a real long-lived Pi instance as the AHDE Builder trust domain. */
export async function launchBuilderPi(options: LaunchBuilderPiOptions = {}): Promise<void> {
	const requestedProjectDir = resolve(options.projectDir ?? process.cwd());
	if (!existsSync(requestedProjectDir)) throw new Error(`Builder project directory does not exist: ${requestedProjectDir}`);
	const projectEntry = lstatSync(requestedProjectDir);
	if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) {
		throw new Error(`Builder project directory must be a regular non-symlink directory: ${requestedProjectDir}`);
	}
	const projectDir = realpathSync(requestedProjectDir);
	// The host is about to create its own store inside the operator's checkout.
	// Ignoring it must happen before anything can see it as uncommitted work:
	// `ahde init` tops up the same rules, but a Target adopted any other way
	// reached the first workshop with `.ahde/` untracked and was refused.
	// Idempotent line by line, and never fatal — a Target outside Git, or one
	// whose `.gitignore` cannot be written, still opens.
	try {
		commitLocalArtifactIgnores(projectDir, ensureLocalArtifactIgnores(projectDir));
	} catch {
		// The dirty checks exclude the host store on their own; this only spares
		// the operator a `.gitignore` they would have had to write by hand.
	}
	const stateRoot = ensurePrivateDirectory(options.stateRoot ?? join(projectDir, ".ahde"));
	const runsRoot = resolve(options.runsRoot ?? join(projectDir, "runs"));
	const privateRoot = ensurePrivateDirectory(join(stateRoot, "builder-pi"));
	const sessionDir = ensurePrivateDirectory(join(privateRoot, "sessions"));
	const builderHome = ensurePrivateDirectory(resolveBuilderHome(options.builderHome));
	const agentDir = ensurePrivateDirectory(join(builderHome, "config"));
	migrateLegacyBuilderConfig(join(privateRoot, "config"), agentDir);
	seedBuilderSettings(agentDir);
	const assets = resolveBuilderAssets(options.packageRoot);
	const runMain = options.main ?? piMain;

	const previousCwd = process.cwd();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
	const previousSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
	try {
		process.chdir(projectDir);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
		// Pi is the embedded runtime, not the installed product. Its self-update
		// notice tells AHDE users to run a binary they did not install and could
		// move the runtime away from AHDE's pinned version.
		process.env.PI_SKIP_VERSION_CHECK = "1";
		let session = await resolveBuilderSession(projectDir, sessionDir, options.sessionMode);
		for (;;) {
			let talkToTarget = false;
			const extensionFactory = options.extensionFactory ?? createAhdeBuilderExtension({
				projectDir,
				stateRoot,
				runsRoot,
				projectId: options.projectId,
				templateDir: assets.targetTemplateDir,
				dependencies: options.dependencies,
				onTalkToTarget: () => {
					talkToTarget = true;
				},
			});
			const args = buildBuilderPiArgs({
				assets,
				sessionDir,
				piArgs: options.piArgs,
				sessionMode: session.mode,
				sessionPath: session.path,
			});
			await runMain(args, {
				extensionFactories: [{ name: "ahde-builder", factory: extensionFactory }],
				allowedBuiltinCommands: AHDE_BUILDER_BUILTIN_COMMANDS,
				preferredExtensionCommands: AHDE_BUILDER_PREFERRED_EXTENSION_COMMANDS,
				allowBash: false,
				resumeHint: false,
				// AHDE's own onboarding selector replaces Pi's "No models available" notice.
				modelFallbackHint: false,
			});
			if (!talkToTarget) break;
			const target = loadTarget(projectDir);
			assertTargetReadyToRun(target);
			await (options.targetRunner ?? runInteractiveTarget)(target);
			// Exiting Runtime Pi returns to the same Builder conversation and state.
			session = await resolveBuilderSession(projectDir, sessionDir, "continue");
		}
	} finally {
		process.chdir(previousCwd);
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
		else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
		if (previousSkipVersionCheck === undefined) delete process.env.PI_SKIP_VERSION_CHECK;
		else process.env.PI_SKIP_VERSION_CHECK = previousSkipVersionCheck;
	}
}
