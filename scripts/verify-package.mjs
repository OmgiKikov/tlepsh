import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workRoot = mkdtempSync(join(tmpdir(), "ahde-package-check-"));
const packDir = join(workRoot, "pack");
const consumerDir = join(workRoot, "consumer");
const globalPrefix = join(workRoot, "global-prefix");
// Builder credentials and Pi settings are user-level (AHDE_HOME, default
// ~/.ahde). Pin them inside the scratch root so verification never touches
// the developer's real home; every child process below inherits this.
const builderHome = join(workRoot, "ahde-home");
process.env.AHDE_HOME = builderHome;

function run(executable, args, options = {}) {
	return execFileSync(executable, args, {
		cwd: options.cwd ?? packageRoot,
		env: options.env ?? process.env,
		encoding: "utf8",
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
		maxBuffer: 64 * 1024 * 1024,
	});
}

try {
	mkdirSync(packDir, { recursive: true });
	mkdirSync(consumerDir, { recursive: true });
	const packed = JSON.parse(run(
		"npm",
		["pack", "--silent", "--json", "--pack-destination", packDir],
		{ capture: true },
	));
	const metadata = packed[0];
	const filename = metadata?.filename;
	if (!filename) throw new Error("npm pack did not return a filename");
	if (metadata.size > 40 * 1024 * 1024) {
		throw new Error(`package tarball exceeds 40 MiB budget: ${metadata.size} bytes`);
	}
	if (metadata.unpackedSize > 128 * 1024 * 1024) {
		throw new Error(`package exceeds 128 MiB unpacked budget: ${metadata.unpackedSize} bytes`);
	}
	// V1.7 added the product-surface modules (render/**, transcript, onboarding,
	// adoption, continuation, impact); the bundled Pi packages dominate the count.
	if (metadata.entryCount > 15_000) {
		throw new Error(`package exceeds 15,000-entry budget: ${metadata.entryCount}`);
	}
	const packedPaths = new Set(metadata.files.map((file) => file.path));
	for (const required of [
		"builders/ahde/AGENTS.md",
		"builders/ahde/skills/design-agent/SKILL.md",
		"builders/ahde/skills/design-evals/SKILL.md",
		"builders/ahde/skills/run-diagnose/SKILL.md",
		"builders/ahde/skills/improve-harness/SKILL.md",
		"dist/application/builder-corpus-import-contract.js",
		"dist/application/builder-corpus-import.js",
		"dist/application/builder-regression-case.js",
		"dist/application/target-scaffold.js",
		"dist/application/target-authoring-context.js",
		"dist/application/target-feedback.js",
		"dist/application/tool-workshop.js",
		"dist/builder/workshop-tools.js",
		"dist/target/feedback-extension.js",
		"dist/builder/product-shell.js",
		"dist/builder/run-observation.js",
		"dist/cli-invocation.js",
		"dist/evidence/live.js",
		"dist/run-events.js",
		"dist/target/command.js",
		"dist/workbench/workbench.js",
		"dist/target/process-entry.js",
	]) {
		if (!packedPaths.has(required)) throw new Error(`packed Builder asset is missing: ${required}`);
	}
	// V1.8 S7 deleted the one-shot CLI Builder adapters, the Pi SDK executor, the
	// approved-Spec corpus-draft generator, the Builder manifest, and the default
	// builder profile. A stale dist/ or a re-added module must fail the gate.
	const removedLegacyPaths = new Set([
		"builders/default/AGENTS.md",
		"builders/default/manifest.yaml",
		"dist/application/corpus-draft.js",
		"dist/builder.js",
		"dist/builders/pi-executor.js",
		"docs/evolution.jsonl",
	]);
	const forbiddenPackedPaths = [...packedPaths].filter((path) =>
		path.includes("builder-workbench") ||
		path.includes("workbench-tui") ||
		path === "builders/companion" ||
		path.startsWith("builders/companion/") ||
		path === "builders/default" ||
		path.startsWith("builders/default/") ||
		removedLegacyPaths.has(path) ||
		(!path.startsWith("node_modules/") &&
			!path.startsWith("vendor/") &&
			/(^|\/)(?:presets?|target-presets?)(?:[.\/-]|$)/i.test(path)) ||
		/(^|\/)studio(?:\.[^/]*)?$/.test(path),
	);
	if (forbiddenPackedPaths.length > 0) {
		throw new Error(
			`packed artifact contains removed Studio/companion/Workbench-TUI/legacy-adapter files: ${forbiddenPackedPaths.slice(0, 20).join(", ")}`,
		);
	}
	const tarball = join(packDir, filename);
	if (!existsSync(tarball)) throw new Error(`package tarball is missing: ${tarball}`);

	// `ahde` is primarily a CLI. A project-local consumer can pass while the
	// advertised global install is broken because npm treats bundled `file:`
	// dependencies differently at a global prefix. Exercise the actual binary.
	mkdirSync(globalPrefix, { recursive: true });
	run(
		"npm",
		["install", "--global", "--prefix", globalPrefix, "--ignore-scripts", "--no-audit", "--no-fund", tarball],
		{ cwd: workRoot },
	);
	const globalCli = join(globalPrefix, "bin", process.platform === "win32" ? "ahde.cmd" : "ahde");
	if (!existsSync(globalCli)) throw new Error("global install did not expose the ahde executable");
	const globalVersion = run(globalCli, ["--version"], { cwd: workRoot, capture: true });
	const globalHelp = run(globalCli, ["--help"], { cwd: workRoot, capture: true });
	if (!/^ahde \d+\.\d+\.\d+\s*$/.test(globalVersion) || !globalHelp.includes("Agent Harness Development Environment")) {
		throw new Error("global-install help/version smoke failed");
	}

	writeFileSync(
		join(consumerDir, "package.json"),
		`${JSON.stringify({ name: "ahde-clean-consumer", private: true, type: "module" }, null, 2)}\n`,
	);
	run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { cwd: consumerDir });
	const cli = join(consumerDir, "node_modules", "ahde", "dist", "cli.js");
	const help = run(process.execPath, [cli, "--help"], { cwd: consumerDir, capture: true });
	const version = run(process.execPath, [cli, "--version"], { cwd: consumerDir, capture: true });
	if (
		!help.includes("Agent Harness Development Environment") ||
		!help.includes("ahde resume") ||
		!/^ahde \d+\.\d+\.\d+\s*$/.test(version)
	) {
		throw new Error("clean-install help/version smoke failed");
	}
	const target = join(consumerDir, "fresh-agent");
	run(process.execPath, [cli, "init", target], { cwd: consumerDir });
	const validation = spawnSync(process.execPath, [cli, "validate", "--target", target], {
		cwd: consumerDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (
		validation.status !== 2 ||
		!validation.stdout.includes("target my-agent: structurally valid") ||
		!validation.stdout.includes("readiness: ACTION REQUIRED")
	) {
		throw new Error(`clean-install validation was not truthful:\n${validation.stdout}\n${validation.stderr}`);
	}
	const smokePath = join(consumerDir, "package-smoke.mjs");
	writeFileSync(smokePath, `
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import {
	AHDE_BUILDER_COMMAND_NAMES,
	AHDE_BUILDER_REGISTERED_TOOL_NAMES,
	AHDE_BUILDER_TOOL_NAMES,
	AHDE_WORKSHOP_TOOL_NAMES,
	openBuilderWorkshop,
  applyBuilderProposal,
  approveBuilderSpecDraft,
  candidateStatus,
  compileImprovementBrief,
  createCorpus,
  createEvidenceExplorer,
	createAhdeWorkbench,
  createTargetToolRuntime,
  describeDevelopmentCorpusPublication,
  describeSpecDraftApproval,
  diagnoseEvalRun,
	deriveEvidenceLinkedProposalSelection,
  importBuilderCorpusDraft,
  inspectTargetAuthoringContext,
  launchBuilderPi,
	loadBuilderCorpusImportReceipt,
  loadCorpus,
  loadTarget,
  promoteReviewedCandidate,
  projectRunEventText,
  publishBuilderDevelopmentCorpus,
	readPublicTargetFile,
  recordBuilderAuthoredProposal,
  resolveBuilderAssets,
	resolveDevelopmentFailureOperations,
	listPublicTargetFiles,
  reviewCandidate,
  runAppliedBuilderCandidate,
	runInteractiveTarget,
  runSuite,
  saveBuilderSpecDraft,
  targetWithDevelopmentCorpus,
} from "ahde";

const expectedToolNames = ["ahde_workbench_view", "ahde_workbench_submit", "ahde_workbench_decide"];
// The workshop four are registered but legal only while a workshop is open.
const expectedWorkshopToolNames = [
	"ahde_workshop_read",
	"ahde_workshop_write",
	"ahde_workshop_bash",
	"ahde_workshop_try",
];
const expectedRegisteredToolNames = [...expectedToolNames, ...expectedWorkshopToolNames];
const expectedCommandNames = [
	"test", "fix", "ship",
	"help", "doctor", "status", "run", "calibrate", "traces", "review",
	"approve", "publish", "apply", "discard", "promote", "reject", "adopt", "next",
	"target",
];

for (const [name, value] of Object.entries({
	AHDE_BUILDER_COMMAND_NAMES,
	AHDE_BUILDER_REGISTERED_TOOL_NAMES,
	AHDE_BUILDER_TOOL_NAMES,
	AHDE_WORKSHOP_TOOL_NAMES,
	openBuilderWorkshop,
  applyBuilderProposal,
  approveBuilderSpecDraft,
  candidateStatus,
  compileImprovementBrief,
  createCorpus,
  createEvidenceExplorer,
	createAhdeWorkbench,
  createTargetToolRuntime,
  describeDevelopmentCorpusPublication,
  describeSpecDraftApproval,
  diagnoseEvalRun,
	deriveEvidenceLinkedProposalSelection,
	importBuilderCorpusDraft,
	inspectTargetAuthoringContext,
  launchBuilderPi,
	loadBuilderCorpusImportReceipt,
  loadCorpus,
  loadTarget,
  promoteReviewedCandidate,
  projectRunEventText,
  publishBuilderDevelopmentCorpus,
	readPublicTargetFile,
  recordBuilderAuthoredProposal,
  resolveBuilderAssets,
	resolveDevelopmentFailureOperations,
	listPublicTargetFiles,
  reviewCandidate,
  runAppliedBuilderCandidate,
	runInteractiveTarget,
  runSuite,
  saveBuilderSpecDraft,
  targetWithDevelopmentCorpus,
})) {
  if (name === "AHDE_BUILDER_TOOL_NAMES") {
    if (JSON.stringify(value) !== JSON.stringify(expectedToolNames)) {
      throw new Error(\`Builder exported the wrong three-operation tool surface: \${JSON.stringify(value)}\`);
    }
  } else if (name === "AHDE_WORKSHOP_TOOL_NAMES") {
    if (JSON.stringify(value) !== JSON.stringify(expectedWorkshopToolNames)) {
      throw new Error(\`Builder exported the wrong workshop tool surface: \${JSON.stringify(value)}\`);
    }
  } else if (name === "AHDE_BUILDER_REGISTERED_TOOL_NAMES") {
    if (JSON.stringify(value) !== JSON.stringify(expectedRegisteredToolNames)) {
      throw new Error(\`Builder exported the wrong registered tool surface: \${JSON.stringify(value)}\`);
    }
  } else if (name === "AHDE_BUILDER_COMMAND_NAMES") {
    if (JSON.stringify(value) !== JSON.stringify(expectedCommandNames)) {
      throw new Error(\`Builder exported the wrong command surface: \${JSON.stringify(value)}\`);
    }
  } else if (typeof value !== "function") {
    throw new Error(\`public API \${name} is not a function\`);
  }
}

const assets = resolveBuilderAssets();
if (!assets.systemPrompt.includes("AHDE") || assets.skillPaths.length !== 4) {
  throw new Error("packaged Builder assets did not resolve completely");
}

const targetDir = ${JSON.stringify(target)};
const runsRoot = ${JSON.stringify(join(consumerDir, "runs"))};
const toolScratch = ${JSON.stringify(join(consumerDir, "target-tool-scratch"))};
const stateRoot = join(targetDir, ".ahde");
const builderHome = ${JSON.stringify(builderHome)};
if (process.env.AHDE_HOME !== builderHome) {
  throw new Error("package verification must pin AHDE_HOME to the scratch home before launching the Builder");
}
mkdirSync(runsRoot, { recursive: true, mode: 0o700 });

const target = loadTarget(targetDir);
if (target.tools.length !== 1 || target.tools[0]?.descriptor.name !== "echo_json") {
  throw new Error("scaffolded Target did not load the packaged echo_json tool");
}
if (!/^sha256:[0-9a-f]{64}$/.test(target.toolsetHash)) {
  throw new Error(\`scaffolded Target has an invalid toolsetHash: \${target.toolsetHash}\`);
}

// Exercise the installed manifest -> broker -> OS sandbox -> executable path,
// rather than merely checking that the descriptor can be loaded.
const targetTools = createTargetToolRuntime({
  target,
  workspaceDir: targetDir,
  scratchDir: toolScratch,
  sourceEnvironment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
});
if (!targetTools.sandboxBackend) throw new Error("Target tool runtime did not select an OS sandbox");
if (targetTools.toolNames.join(",") !== "echo_json" || targetTools.customTools.length !== 1) {
  throw new Error(\`Target runtime registered unexpected tools: \${targetTools.toolNames.join(", ")}\`);
}
const echoTool = targetTools.customTools[0];
const echoResult = await echoTool.execute(
  "package-smoke-echo",
  { message: "installed-package" },
  undefined,
  undefined,
  undefined,
);
const echoText = echoResult.content
  .filter((part) => part.type === "text")
  .map((part) => part.text ?? "")
  .join("\\n");
const echoPayload = JSON.parse(echoText);
if (echoPayload.message !== "installed-package" || echoResult.details?.exitCode !== 0) {
  throw new Error(\`installed Target echo_json execution failed: \${echoText}\`);
}

// Launch through the public Builder entry point, but replace only Pi's blocking
// interactive loop. This still exercises AHDE's real isolation roots, exact Pi
// arguments, packaged prompt/skills, inline extension factory, and tool guard.
const originalCwd = process.cwd();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
let builderMainCalled = false;
await launchBuilderPi({
  projectDir: targetDir,
  stateRoot,
  runsRoot,
  projectId: target.manifest.id,
  piArgs: ["--thinking", "off"],
  main: async (args, options) => {
    builderMainCalled = true;
    if (args.includes("--resume")) throw new Error("fresh Builder launch unexpectedly resumed a session");
    if (realpathSync(process.cwd()) !== realpathSync(targetDir)) {
      throw new Error("Builder Pi did not start in the Target directory");
    }
    for (const required of [
      "--no-builtin-tools",
      "--no-extensions",
      "--no-skills",
      "--no-context-files",
      "--no-prompt-templates",
      "--no-themes",
    ]) {
      if (!args.includes(required)) throw new Error(\`Builder Pi omitted isolation flag \${required}\`);
    }
    const systemPromptIndex = args.indexOf("--system-prompt");
    if (systemPromptIndex < 0 || args[systemPromptIndex + 1] !== assets.systemPrompt) {
      throw new Error("Builder Pi did not receive the exact packaged system prompt");
    }
    const suppliedSkills = args
      .map((value, index) => value === "--skill" ? args[index + 1] : undefined)
      .filter(Boolean);
    if (JSON.stringify(suppliedSkills) !== JSON.stringify(assets.skillPaths)) {
      throw new Error("Builder Pi did not receive the exact four packaged skills");
    }
    const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
    const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR ?? "";
    if (!existsSync(agentDir) || !existsSync(sessionDir)) {
      throw new Error("Builder Pi private config/session roots were not materialized");
    }
    if (agentDir !== realpathSync(join(builderHome, "builder-pi", "config"))) {
      throw new Error("Builder Pi config did not resolve to the user-level AHDE_HOME");
    }
    if (sessionDir !== realpathSync(join(stateRoot, "builder-pi", "sessions"))) {
      throw new Error("Builder Pi sessions did not stay under the per-project state root");
    }
    if (existsSync(join(stateRoot, "builder-pi", "config"))) {
      throw new Error("Builder Pi still materialized a per-project config directory");
    }
    const seededSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
    if (seededSettings.quietStartup !== true) {
      throw new Error("Builder Pi settings were not seeded for a quiet embedded startup");
    }

    const factories = options?.extensionFactories ?? [];
    if (factories.length !== 1 || factories[0]?.name !== "ahde-builder") {
      throw new Error("Builder Pi did not receive exactly one trusted AHDE extension");
    }
    const registeredTools = [];
    const registeredCommands = [];
    const handlers = new Map();
    await factories[0].factory({
      on(event, handler) { handlers.set(event, handler); },
      registerTool(tool) { registeredTools.push(tool); },
      registerCommand(name, command) { registeredCommands.push({ name, command }); },
    });
    const actualNames = registeredTools.map((tool) => tool.name);
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedRegisteredToolNames)) {
      throw new Error(\`Builder extension registered an unexpected tool surface: \${actualNames.join(", ")}\`);
    }
    // The hands exist, and they are refused until a workshop binds them.
    for (const workshopToolName of expectedWorkshopToolNames) {
      const workshopTool = registeredTools.find((tool) => tool.name === workshopToolName);
      let refused = false;
      try {
        await workshopTool?.execute("package-workshop", { path: "AGENTS.md", argv: ["true"], tool: "echo_json", input: {} }, undefined, undefined, undefined);
      } catch (error) {
        refused = /no workshop is open/.test(String(error?.message ?? error));
      }
      if (!refused) throw new Error(\`\${workshopToolName} did not fail closed without an open workshop\`);
    }
    const workshopGuard = handlers.get("tool_call");
    const workshopBlocked = workshopGuard?.({ toolName: "ahde_workshop_write" });
    if (workshopBlocked?.block !== true || !/workshop-open/.test(String(workshopBlocked.reason))) {
      throw new Error("installed Builder did not gate the workshop tools behind an open workshop");
    }
    if (workshopGuard?.({ toolName: "write" })?.terminate !== true) {
      throw new Error("installed Builder still allows a generic write tool");
    }
    const actualCommands = registeredCommands.map(({ name }) => name);
    if (JSON.stringify(actualCommands) !== JSON.stringify(expectedCommandNames)) {
      throw new Error(\`Builder extension registered an unexpected command surface: \${actualCommands.join(", ")}\`);
    }
    const viewTool = registeredTools.find((tool) => tool.name === "ahde_workbench_view");
    const decideTool = registeredTools.find((tool) => tool.name === "ahde_workbench_decide");
    const viewResult = await viewTool?.execute("package-view", {}, undefined, undefined, undefined);
    if (!viewResult || typeof viewResult.details?.stage !== "string") {
      throw new Error("installed Workbench view handler did not return a stage");
    }
    const targetOverview = await viewTool?.execute(
      "package-target-overview",
      { aspect: "target" },
      undefined,
      undefined,
      undefined,
    );
    const targetContext = targetOverview?.details?.detail?.content;
    if (
      targetContext?.algorithmId !== "git-manifest-context-v1" ||
	  targetContext?.claim?.contextHash !== targetContext?.contextHash ||
      !targetContext.resources?.some((resource) => resource.path === "AGENTS.md") ||
      !targetContext.resources?.some((resource) => resource.path === "tools/echo_json.tool.yaml")
    ) throw new Error("installed Workbench omitted exact declared Target authoring context");
    if (JSON.stringify(targetContext).includes(targetDir) || JSON.stringify(targetContext).includes("manifest.yaml")) {
      throw new Error("installed Target overview leaked an absolute path or raw manifest");
    }
    const targetResource = await viewTool?.execute(
      "package-target-resource",
      { aspect: "target", resourcePath: "AGENTS.md" },
      undefined,
      undefined,
      undefined,
    );
    if (
      targetResource?.details?.detail?.content?.resource?.path !== "AGENTS.md" ||
      !targetResource?.details?.detail?.content?.resource?.content?.includes("# My Agent")
    ) throw new Error("installed Workbench did not return exact AGENTS.md content");
	const compatibilityFiles = listPublicTargetFiles(targetDir);
	if (!compatibilityFiles.some((resource) => resource.path === "AGENTS.md")) {
	  throw new Error("installed package broke the deprecated declared-resource list export");
	}
	const compatibilityRead = readPublicTargetFile(targetDir, "AGENTS.md");
	if (compatibilityRead.path !== "AGENTS.md" || !compatibilityRead.content.includes("# My Agent")) {
	  throw new Error("installed package broke the deprecated exact-Git read export");
	}
    let decideFailedClosed = false;
    try {
      await decideTool?.execute(
        "package-decide",
        { kind: "configure-target", targetId: "fresh-agent", model: { provider: "mock", id: "model", apiKeyEnv: "MOCK_API_KEY" }, reason: "package smoke" },
        undefined,
        undefined,
        { hasUI: false, mode: "rpc" },
      );
    } catch (error) {
      decideFailedClosed = /requires a local TUI host confirmation/.test(String(error));
    }
    if (!decideFailedClosed) throw new Error("installed Workbench decision handler did not fail closed outside TUI");

    const notifications = [];
    const commandContext = {
      hasUI: true,
      mode: "tui",
      waitForIdle: async () => {},
      model: null,
      modelRegistry: { hasConfiguredAuth: () => false },
      ui: { notify: (message, level) => notifications.push({ message, level }) },
    };
    for (const name of ["help", "doctor", "status"]) {
      const command = registeredCommands.find((entry) => entry.name === name)?.command;
      if (!command) throw new Error(\`installed /\${name} command is missing\`);
      await command.handler("", commandContext);
    }
    if (
      !notifications.some(({ message }) => message.includes("AHDE Builder") && message.includes("/help")) ||
      !notifications.some(({ message }) => message.includes("AHDE Doctor")) ||
      !notifications.some(({ message }) => message.includes("AHDE ·"))
    ) {
      throw new Error("installed AHDE help/doctor/status handlers did not produce branded output");
    }
    const guard = handlers.get("tool_call");
    const bashGuard = handlers.get("user_bash");
    if (typeof guard !== "function" || typeof bashGuard !== "function") {
      throw new Error("Builder extension did not install its shell/tool guards");
    }
    const blocked = await guard({ toolName: "bash" }, {});
    const allowed = await guard({ toolName: "ahde_workbench_view" }, {});
    const shell = await bashGuard({}, {});
    if (blocked?.block !== true || blocked?.terminate !== true || allowed !== undefined) {
      throw new Error("Builder extension tool allowlist guard is not fail-closed");
    }
    if (shell?.result?.exitCode !== 126) throw new Error("Builder extension did not disable interactive shell execution");
	if (options?.allowBash !== false || options?.resumeHint !== false) {
	  throw new Error("Builder Pi host policy did not disable bash/resume leakage");
	}
	const expectedBuiltins = ["login", "logout", "model", "thinking", "compact", "new", "resume", "session", "name", "copy", "hotkeys", "quit"];
	if (JSON.stringify(options?.allowedBuiltinCommands) !== JSON.stringify(expectedBuiltins)) {
	  throw new Error("Builder Pi host policy did not restrict built-in commands");
	}
	if (JSON.stringify(options?.preferredExtensionCommands) !== JSON.stringify(["help", "status"])) {
	  throw new Error("Builder Pi host policy did not prefer AHDE help/status commands");
	}
  },
});
if (!builderMainCalled) throw new Error("launchBuilderPi did not invoke the Pi host");
if (process.cwd() !== originalCwd) throw new Error("launchBuilderPi did not restore cwd");
if (process.env.PI_CODING_AGENT_DIR !== originalAgentDir) throw new Error("launchBuilderPi did not restore PI_CODING_AGENT_DIR");
if (process.env.PI_CODING_AGENT_SESSION_DIR !== originalSessionDir) {
  throw new Error("launchBuilderPi did not restore PI_CODING_AGENT_SESSION_DIR");
}

let resumeMainCalled = false;
await launchBuilderPi({
  projectDir: targetDir,
  stateRoot,
  runsRoot,
  projectId: target.manifest.id,
  sessionMode: "resume",
  main: async (args) => {
    resumeMainCalled = true;
    if (process.env.PI_CODING_AGENT_DIR !== realpathSync(join(builderHome, "builder-pi", "config"))) {
      throw new Error("resumed Builder Pi did not reuse the user-level config home");
    }
    if (args.filter((argument) => argument === "--resume").length !== 1) {
      throw new Error("host-owned Builder resume did not supply exactly one --resume flag");
    }
  },
});
if (!resumeMainCalled) throw new Error("host-owned Builder resume did not invoke the Pi host");
if (process.cwd() !== originalCwd) throw new Error("resumed Builder Pi did not restore cwd");
if (process.env.PI_CODING_AGENT_DIR !== originalAgentDir) throw new Error("resumed Builder Pi did not restore PI_CODING_AGENT_DIR");
if (process.env.PI_CODING_AGENT_SESSION_DIR !== originalSessionDir) {
  throw new Error("resumed Builder Pi did not restore PI_CODING_AGENT_SESSION_DIR");
}

// Exercise the installed read-only HTTP server on a real loopback socket.
const explorer = createEvidenceExplorer({ runsRoot });
const address = await explorer.listen();
try {
  if (address.host !== "127.0.0.1" || address.url !== \`http://127.0.0.1:\${address.port}\`) {
    throw new Error(\`Evidence Explorer bound an unexpected address: \${address.url}\`);
  }
  const health = await fetch(\`\${address.url}/healthz\`, { signal: AbortSignal.timeout(5_000) });
  if (health.status !== 200 || JSON.stringify(await health.json()) !== JSON.stringify({ ok: true })) {
    throw new Error("Evidence Explorer health endpoint failed");
  }
  const index = await fetch(address.url, { signal: AbortSignal.timeout(5_000) });
  const html = await index.text();
  if (index.status !== 200 || !html.includes("AHDE Evidence") || !html.includes("Sealed holdout traces are never exposed")) {
    throw new Error("Evidence Explorer did not serve its empty read-only index");
  }
  if (!index.headers.get("content-security-policy")?.includes("default-src 'none'") || index.headers.get("cache-control") !== "no-store") {
    throw new Error("Evidence Explorer omitted required read-only security headers");
  }
  const live = explorer.startLiveTrace();
  const liveUrl = address.urlForLiveTrace(live.id);
  const livePage = await fetch(liveUrl, { signal: AbortSignal.timeout(5_000) });
  const liveHtml = await livePage.text();
  if (
    livePage.status !== 200 ||
    !liveHtml.includes("AHDE Live Trace") ||
    !livePage.headers.get("content-security-policy")?.includes("connect-src 'self'") ||
    livePage.headers.get("cross-origin-resource-policy") !== "same-origin"
  ) {
    throw new Error("Evidence Explorer did not serve the protected live trace shell");
  }
  const liveStream = await fetch(address.url + "/api/live/" + live.id + "/events", {
    signal: AbortSignal.timeout(5_000),
  });
  live.onRunEvent({
    type: "assistant_delta",
    at: new Date().toISOString(),
    run: {
      evalRunId: "erun_package_live",
      runId: "run_package_live",
      taskId: "task-package-live",
      repetitionIndex: 0,
      ordinal: 1,
      total: 1,
    },
    delta: "PACKAGE_LIVE_CANARY",
    truncated: false,
  });
  live.finish("completed");
  const liveBody = await liveStream.text();
  if (
    liveStream.status !== 200 ||
    !liveBody.includes("PACKAGE_LIVE_CANARY") ||
    !liveBody.includes('"status":"completed"')
  ) {
    throw new Error("Evidence Explorer live SSE did not stream and retain bounded RunEvents");
  }
  const mutation = await fetch(address.url, {
    method: "POST",
    body: "forbidden",
    signal: AbortSignal.timeout(5_000),
  });
  if (mutation.status !== 405 || mutation.headers.get("allow") !== "GET, HEAD") {
    throw new Error("Evidence Explorer accepted a mutation method");
  }
} finally {
  await explorer.close();
}

// Full installed-package acceptance path. The model endpoint is loopback-only,
// stateless, bounded, and returns a deterministic answer based solely on the
// Target system instructions. No external network or model token is used.
const NL = String.fromCharCode(10);
const contentText = (content) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part && typeof part === "object" && "text" in part ? String(part.text) : "").join("");
};
let scriptedRequests = 0;
const scriptedModel = createServer((request, response) => {
  const chunks = [];
  let bytes = 0;
  request.on("data", (chunk) => {
    bytes += chunk.byteLength;
    if (bytes <= 1024 * 1024) chunks.push(Buffer.from(chunk));
  });
  request.on("end", () => {
    if (!(request.url ?? "").includes("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    scriptedRequests += 1;
    // 1 source baseline + (1 dev + 15 sealed) tasks x 2 repetitions x 2 arms = 65.
    if (bytes > 1024 * 1024 || scriptedRequests > 80) {
      response.writeHead(bytes > 1024 * 1024 ? 413 : 429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "bounded package fixture limit exceeded" } }));
      return;
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid JSON" } }));
      return;
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = typeof body.system === "string"
      ? body.system
      : Array.isArray(body.system)
        ? contentText(body.system)
        : messages.filter((message) => message?.role === "system").map((message) => contentText(message.content)).join(NL);
    const answer = system.includes("Return the exact uppercase word READY.") ? "READY" : "pending";
    const model = typeof body.model === "string" ? body.model : "package-smoke-model";
    const base = {
      id: "chatcmpl-package-smoke",
      object: "chat.completion.chunk",
      created: 1,
      model,
    };
    const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    if (body.stream === false) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: base.id,
        object: "chat.completion",
        created: base.created,
        model,
        choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
        usage,
      }));
      return;
    }
    const event = (payload) => "data: " + JSON.stringify(payload) + NL + NL;
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "close",
    });
    response.end(
      event({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }] }) +
      event({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }) +
      "data: [DONE]" + NL + NL,
    );
  });
});
await new Promise((resolveListen, rejectListen) => {
  scriptedModel.once("error", rejectListen);
  scriptedModel.listen(0, "127.0.0.1", () => {
    scriptedModel.off("error", rejectListen);
    resolveListen();
  });
});
const scriptedAddress = scriptedModel.address();
if (!scriptedAddress || typeof scriptedAddress === "string") throw new Error("scripted model did not bind loopback");
const scriptedBaseUrl = "http://127.0.0.1:" + scriptedAddress.port + "/v1";
const closeScriptedModel = () => new Promise((resolveClose, rejectClose) => {
  scriptedModel.close((error) => error ? rejectClose(error) : resolveClose());
});

const modelKeyName = "AHDE_PACKAGE_SMOKE_MODEL_KEY";
process.env[modelKeyName] = "local-fixture-only";
try {
  const git = (...args) => execFileSync("git", ["-C", targetDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const baselineInstructions = [
    "# Package lifecycle agent",
    "",
    "Return the lowercase word pending.",
    "",
  ].join(NL);
  writeFileSync(join(targetDir, "AGENTS.md"), baselineInstructions);
  const manifestPath = join(targetDir, "manifest.yaml");
  const originalManifest = readFileSync(manifestPath, "utf8");
  const configuredManifest = originalManifest
    .replace("id: replace-with-model-id", "id: package-smoke-model")
    .replace("baseUrl: http://127.0.0.1:1234/v1", "baseUrl: " + scriptedBaseUrl)
    .replace("apiKeyEnv: AHDE_MODEL_API_KEY", "apiKeyEnv: " + modelKeyName)
    .replace("timeoutMs: 300000", "timeoutMs: 30000");
  if (configuredManifest === originalManifest || !configuredManifest.includes(scriptedBaseUrl)) {
    throw new Error("could not configure the packed Target manifest for the local model fixture");
  }
  writeFileSync(manifestPath, configuredManifest);
  git("add", "AGENTS.md", "manifest.yaml");
  git(
    "-c", "user.name=AHDE package smoke",
    "-c", "user.email=package-smoke@ahde.local",
    "commit", "--no-gpg-sign", "-m", "Configure deterministic package acceptance Target",
  );
  if (git("status", "--porcelain") !== "") throw new Error("configured acceptance Target is not clean");

  const projectId = loadTarget(targetDir).manifest.id;
  const actor = { kind: "human", id: "package-smoke-operator" };
  const draft = saveBuilderSpecDraft({
    stateRoot,
    projectId,
    sourceText: "Create a deterministic READY response agent.",
    spec: {
      schemaVersion: 1,
      title: "Installed package lifecycle agent",
      purpose: "Return a deterministic reviewed answer.",
      users: ["package acceptance reviewer"],
      jobs: ["answer one bounded request"],
      inputs: ["text request"],
      allowedActions: ["return text"],
      successCriteria: ["answer contains READY"],
      constraints: ["no external network"],
      openQuestions: [],
    },
  });
  const specSubject = describeSpecDraftApproval(stateRoot, projectId, draft.id);
  const approval = approveBuilderSpecDraft({
    stateRoot,
    projectId,
    draftSpecId: draft.id,
    expectedDraftSnapshotHash: specSubject.draftSnapshotHash,
    actor,
    reason: "Approve exact package acceptance contract.",
  });

  const importInbox = join(targetDir, "imports");
  mkdirSync(importInbox, { recursive: true });
  writeFileSync(join(importInbox, "package-examples.jsonl"), JSON.stringify({
    id: "caller-owned-id",
    input: "Answer an imported package request.",
    graders: [{ type: "output_contains", text: "READY" }],
  }) + NL);
  const importedDraft = importBuilderCorpusDraft({
    stateRoot,
    projectDir: targetDir,
    runsRoot,
    approvedSpec: approval.receipt.approvedSpec,
    sourcePath: "imports/package-examples.jsonl",
    name: "Installed package import",
    revisionSummary: "Exercise the packaged private import inbox.",
  });
  if (
    importedDraft.draft.tasks.length !== 1 ||
    importedDraft.draft.tasks[0]?.id === "caller-owned-id" ||
    importedDraft.draft.importSource?.path !== "imports/package-examples.jsonl" ||
    loadBuilderCorpusImportReceipt(stateRoot, projectId, importedDraft.receipt.id).id !== importedDraft.receipt.id
  ) throw new Error("installed-package corpus import did not preserve exact trusted provenance");

  const developmentTasks = [{
    id: "package-dev-1",
    input: "Answer the package acceptance request.",
    graders: [{ type: "output_contains", text: "READY" }],
  }];
  const corpusSubject = describeDevelopmentCorpusPublication({
    projectId,
    name: "Installed package development",
    tasks: developmentTasks,
  });
  const publication = publishBuilderDevelopmentCorpus({
    stateRoot,
    projectId,
    name: corpusSubject.name,
    tasks: developmentTasks,
    expectedSubjectHash: corpusSubject.subjectHash,
    actor,
    reason: "Publish exact package acceptance task.",
  });
  const developmentRef = { stateRoot, projectId, corpusId: publication.corpus.id };
  const developmentTarget = targetWithDevelopmentCorpus(loadTarget(targetDir), loadCorpus(developmentRef));
  const sourceBaseline = await runSuite(developmentTarget, {
    runsRoot,
    label: "baseline",
    repetitions: 1,
  });
  if (sourceBaseline.summary.fail !== 1 || sourceBaseline.summary.pass !== 0 || sourceBaseline.summary.error !== 0) {
    throw new Error("installed-package baseline did not produce the expected deterministic failure");
  }
  const diagnosis = diagnoseEvalRun(runsRoot, sourceBaseline.evalRunId);
  if (diagnosis.status === "inconclusive" || diagnosis.summary.issueCount < 1) {
    throw new Error("installed-package baseline diagnosis did not identify the failure");
  }
  const improvementBrief = compileImprovementBrief(runsRoot, diagnosis);
  const selectedMode = improvementBrief.modes.find((mode) => mode.decision === "propose-harness-change");
  if (!selectedMode) throw new Error("installed-package baseline has no proposal-eligible failure mode");
  const proposalBasis = {
    algorithmId: improvementBrief.algorithmId,
    evalRunId: improvementBrief.evalRunId,
    diagnosisId: improvementBrief.diagnosisId,
    briefId: improvementBrief.briefId,
    failureModeIds: [selectedMode.failureModeId],
  };
  const selectedEvidence = deriveEvidenceLinkedProposalSelection(improvementBrief, proposalBasis);
  const evidenceRefs = [...new Set(selectedEvidence.diagnoses.flatMap((item) => item.evidence))];

  const before = readFileSync(join(targetDir, "AGENTS.md"), "utf8");
  const after = before.trimEnd() + NL + NL + "Return the exact uppercase word READY." + NL;
  const oldLines = before.endsWith(NL) ? before.slice(0, -1).split(NL) : before.split(NL);
  const newLines = after.endsWith(NL) ? after.slice(0, -1).split(NL) : after.split(NL);
  const exactDiff = [
    "diff --git a/AGENTS.md b/AGENTS.md",
    "--- a/AGENTS.md",
    "+++ b/AGENTS.md",
    "@@ -1," + oldLines.length + " +1," + newLines.length + " @@",
    ...oldLines.map((line) => "-" + line),
    ...newLines.map((line) => "+" + line),
  ].join(NL);
  const sha256 = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const proposal = {
    schemaVersion: 1,
    decision: "propose",
    baseTargetSha: developmentTarget.gitSha,
    summary: "Make the approved answer contract explicit.",
    diagnoses: selectedEvidence.diagnoses,
    changes: [{
      path: "AGENTS.md",
      baseSha256: sha256(before),
      unifiedDiff: exactDiff,
      rationale: "Align the harness with the approved observable contract.",
      evidenceRefs,
    }],
    risks: ["The package fixture intentionally uses a narrow answer contract."],
    validationPlan: ["Run matched development and evaluator-only sealed evidence."],
  };
  const builder = await recordBuilderAuthoredProposal({
    proposal,
    approvedSpec: { stateRoot, projectId, specId: approval.approved.id },
    targetDir,
    allowedPaths: ["AGENTS.md", "skills/**", "tools/**", "bin/**"],
    sourceEvalRunId: sourceBaseline.evalRunId,
    proposalBasis,
    runsRoot,
    timeoutMs: 30_000,
    runId: "builder-package-lifecycle",
  });
  if (builder.record.request.provenanceMode !== "canonical" || builder.record.request.source?.evalRunId !== sourceBaseline.evalRunId) {
    throw new Error("direct Builder proposal did not preserve canonical source provenance");
  }
  const checkoutBeforeApply = git("rev-parse", "HEAD");
  const branchBeforeApply = git("branch", "--show-current");
  const applied = applyBuilderProposal({
    repoDir: targetDir,
    runsRoot,
    runId: builder.record.runId,
    requestedBranch: "candidate/package-lifecycle",
    actor,
    reason: "Apply the exact reviewed package smoke diff.",
  });
  if (applied.receipt.baseTargetSha !== checkoutBeforeApply || git("rev-parse", "HEAD") !== checkoutBeforeApply || git("branch", "--show-current") !== branchBeforeApply) {
    throw new Error("canonical proposal apply changed the operator checkout or used the wrong base");
  }

  const sealedInput = "PRIVATE_PACKAGE_HOLDOUT_CONTENT";
  const sealed = createCorpus({
    stateRoot,
    projectId,
    name: "Evaluator-only installed package holdout",
    visibility: "sealed",
    // The sealed guardrail needs at least 15 tasks × 2 repetitions for a verdict.
    tasks: Array.from({ length: 15 }, (_, index) => ({
      id: \`package-holdout-\${index + 1}\`,
      input: \`\${sealedInput} \${index + 1}\`,
      graders: [{ type: "output_contains", text: "READY" }],
    })),
  });
  const experiment = await runAppliedBuilderCandidate({
    repositoryDir: targetDir,
    runsRoot,
    builderRunId: builder.record.runId,
    projectId,
    approvedSpec: { stateRoot, specId: approval.approved.id },
    repetitions: 2,
    developmentCorpus: developmentRef,
    sealedCorpus: { stateRoot, projectId, corpusId: sealed.id },
    candidateId: "candidate-package-lifecycle",
    actorId: actor.id,
  });
  if (
    experiment.compare.status !== "comparable" ||
    experiment.baseline.summary.pass !== 0 ||
    experiment.candidate.summary.pass !== experiment.candidate.summary.total ||
    experiment.compare.summary.delta !== 1 ||
    experiment.compare.gate.verdict !== "improved" ||
    !experiment.sealedHoldout ||
    experiment.sealedHoldout.compare.status !== "comparable" ||
    experiment.sealedHoldout.baseline.summary.pass !== 0 ||
    experiment.sealedHoldout.candidate.summary.pass !== experiment.sealedHoldout.candidate.summary.total ||
    experiment.sealedHoldout.compare.summary.delta !== 1 ||
    experiment.sealedHoldout.compare.gate.verdict !== "pass"
  ) {
    throw new Error("installed-package matched development/sealed candidate gate did not produce fail-to-pass evidence");
  }
  if (JSON.stringify(experiment).includes(sealedInput) || candidateStatus(experiment.record) !== "evaluated") {
    throw new Error("candidate result leaked sealed content or did not reach evaluated status");
  }
  const reviewed = reviewCandidate({
    runsRoot,
    candidateId: experiment.record.candidateId,
    recommendation: "promote",
    reason: "Matched development improved and sealed evidence passed.",
    actorId: actor.id,
  });
  if (candidateStatus(reviewed) !== "reviewed") throw new Error("candidate did not reach reviewed status");
  const promotion = promoteReviewedCandidate({
    repositoryDir: targetDir,
    runsRoot,
    candidateId: experiment.record.candidateId,
    version: "9.9.9",
    reason: "Promote the exact reviewed installed-package candidate.",
    actorId: actor.id,
  });
  if (
    promotion.tag !== "v9.9.9" ||
    candidateStatus(promotion.record) !== "promoted" ||
    git("rev-list", "-n", "1", promotion.tag) !== promotion.candidateSha ||
    promotion.candidateSha !== applied.receipt.candidateSha
  ) {
    throw new Error("installed-package candidate promotion did not tag the exact reviewed commit");
  }
  if (scriptedRequests < 60 || scriptedRequests > 80) {
    throw new Error("scripted model request count was outside the bounded lifecycle expectation: " + scriptedRequests);
  }
} finally {
  delete process.env[modelKeyName];
  await closeScriptedModel();
}
`);
	run(process.execPath, [smokePath], { cwd: consumerDir, capture: true });
	const installedManifest = JSON.parse(
		readFileSync(join(consumerDir, "node_modules", "ahde", "package.json"), "utf8"),
	);
	console.log(
		`verified ${installedManifest.name}@${installedManifest.version}: pack → clean install → init → validate → Builder startup + sandboxed Target tool + loopback live/final Evidence HTTP + canonical candidate promotion`,
	);
} finally {
	rmSync(workRoot, { recursive: true, force: true });
}
