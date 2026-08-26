import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main as piMain, type ExtensionFactory, type MainOptions } from "@earendil-works/pi-coding-agent";
import { createAhdeBuilderExtension, type BuilderExtensionDependencies } from "./extension.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BUILDER_SKILLS = ["design-agent", "design-evals", "run-diagnose", "improve-harness"] as const;

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
	packageRoot?: string;
	piArgs?: string[];
	dependencies?: Partial<BuilderExtensionDependencies>;
	main?: (args: string[], options?: MainOptions) => Promise<void>;
	extensionFactory?: ExtensionFactory;
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
		systemPrompt: readFileSync(systemPromptPath, "utf8"),
		skillPaths,
		targetTemplateDir,
	};
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

export function buildBuilderPiArgs(input: {
	assets: BuilderAssets;
	sessionDir: string;
	piArgs?: readonly string[];
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
	const stateRoot = ensurePrivateDirectory(options.stateRoot ?? join(projectDir, ".ahde"));
	const runsRoot = resolve(options.runsRoot ?? join(projectDir, "runs"));
	const privateRoot = ensurePrivateDirectory(join(stateRoot, "builder-pi"));
	const agentDir = ensurePrivateDirectory(join(privateRoot, "config"));
	const sessionDir = ensurePrivateDirectory(join(privateRoot, "sessions"));
	const assets = resolveBuilderAssets(options.packageRoot);
	const extensionFactory = options.extensionFactory ?? createAhdeBuilderExtension({
		projectDir,
		stateRoot,
		runsRoot,
		projectId: options.projectId,
		templateDir: assets.targetTemplateDir,
		dependencies: options.dependencies,
	});
	const args = buildBuilderPiArgs({ assets, sessionDir, piArgs: options.piArgs });
	const runMain = options.main ?? piMain;

	const previousCwd = process.cwd();
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
	try {
		process.chdir(projectDir);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
		await runMain(args, {
			extensionFactories: [{ name: "ahde-builder", factory: extensionFactory }],
		});
	} finally {
		process.chdir(previousCwd);
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousSessionDir === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
		else process.env.PI_CODING_AGENT_SESSION_DIR = previousSessionDir;
	}
}
