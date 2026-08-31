import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildExecutionPolicy } from "../src/execution-policy.js";
import { loadTarget } from "../src/manifest.js";
import { hashFile } from "../src/provenance.js";
import {
	CONTAINER_PATH,
	containerImageDigest,
	containerSandboxFingerprint,
	describeSandboxReadiness,
	detectContainerRuntime,
	dockerBackend,
	GONDOLIN_UNAVAILABLE,
	gondolinBackend,
	isPinnedContainerImage,
	resetContainerRuntimeDetection,
	resolveContainerSandbox,
	resolveExecutionBackend,
	type ContainerPolicy,
	type ContainerRuntimeStatus,
} from "../src/target/container-backend.js";
import { prepareToolHome } from "../src/target/tool-setup.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const PINNED = `registry.example.com/ahde/target@${DIGEST}`;
const TAG = "registry.example.com/ahde/target:1.2.3";
/** Set in the parent process before every argv assertion; must never reach a container. */
const HOST_SECRET = "AHDE_CONTAINER_TEST_HOST_SECRET";

const roots: string[] = [];

function scratchRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), `ahde-${prefix}-`));
	roots.push(root);
	return root;
}

afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
	delete process.env[HOST_SECRET];
	resetContainerRuntimeDetection();
});

beforeEach(() => {
	resetContainerRuntimeDetection();
});

function policy(overrides: Partial<ContainerPolicy> = {}): ContainerPolicy {
	return {
		runtime: "docker",
		image: PINNED,
		workdir: "/workspace",
		readOnlyRootfs: true,
		...overrides,
	};
}

/**
 * A `docker` on PATH that answers the version probe exactly the way the real
 * client does, and records every later invocation's argv. Nothing here needs a
 * daemon: the point is the argv the harness constructs.
 */
function fakeDocker(options: { version?: string; failReason?: string; logPath?: string } = {}): {
	binDir: string;
	logPath: string;
} {
	const binDir = join(scratchRoot("fake-docker"), "bin");
	mkdirSync(binDir, { recursive: true });
	const logPath = options.logPath ?? join(binDir, "..", "docker-argv.log");
	const versionBranch = options.failReason
		? `printf '%s\\n' ${JSON.stringify(options.failReason)} >&2; exit 1`
		: `printf '%s\\n' ${JSON.stringify(options.version ?? "27.1.0")}`;
	const script = `#!/bin/sh
if [ "$1" = "version" ]; then
${versionBranch}
fi
: > ${JSON.stringify(logPath)}
for argument in "$@"; do printf '%s\\n' "$argument" >> ${JSON.stringify(logPath)}; done
printf 'fake-docker-ran\\n'
`;
	const binary = join(binDir, "docker");
	writeFileSync(binary, script);
	chmodSync(binary, 0o755);
	return { binDir, logPath };
}

function loggedArgv(logPath: string): string[] {
	return readFileSync(logPath, "utf8").split("\n").filter((line) => line.length > 0);
}

function flagValues(args: readonly string[], flag: string): string[] {
	const values: string[] = [];
	for (const [index, argument] of args.entries()) {
		if (argument === flag && args[index + 1] !== undefined) values.push(args[index + 1] as string);
	}
	return values;
}

function environmentMap(args: readonly string[]): Record<string, string> {
	const map: Record<string, string> = {};
	for (const entry of flagValues(args, "-e")) {
		const split = entry.indexOf("=");
		map[entry.slice(0, split)] = entry.slice(split + 1);
	}
	return map;
}

function invocationFixture(overrides: {
	container?: Partial<ContainerPolicy>;
	network?: "deny" | "allow";
	environment?: NodeJS.ProcessEnv;
	toolHomeRoot?: string;
	toolHomeMode?: "ro" | "rw";
	argv?: string[];
	cwd?: string;
} = {}) {
	const root = scratchRoot("container-argv");
	const workspaceDir = join(root, "workspace");
	const scratchDir = join(root, "scratch");
	const toolHomeRoot = overrides.toolHomeRoot === undefined ? join(root, "tools") : overrides.toolHomeRoot;
	mkdirSync(workspaceDir, { recursive: true });
	mkdirSync(scratchDir, { recursive: true });
	if (toolHomeRoot) mkdirSync(toolHomeRoot, { recursive: true });
	return {
		root,
		workspaceDir,
		scratchDir,
		toolHomeRoot,
		invocation: dockerBackend.invocation({
			policy: policy(overrides.container ?? {}),
			mounts: {
				workspaceDir,
				scratchDir,
				...(toolHomeRoot ? { toolHomeRoot } : {}),
				...(overrides.toolHomeMode ? { toolHomeMode: overrides.toolHomeMode } : {}),
			},
			network: overrides.network ?? "deny",
			environment: overrides.environment ?? {
				PATH: "/opt/homebrew/bin:/usr/bin",
				HOME: join(scratchDir, "tool-home/echo_json"),
				TMPDIR: join(scratchDir, "tool-tmp/echo_json"),
				LANG: "C",
			},
			cwd: overrides.cwd ?? workspaceDir,
			argv: overrides.argv ?? [join(workspaceDir, "bin/echo_json")],
			user: "1000:1000",
			hostEnvironment: { PATH: "/usr/bin:/bin", HOME: "/host/home" },
		}),
	};
}

describe("container backend argv", () => {
	it("builds the exact docker run template for a pinned image with every declared limit", () => {
		const fixture = invocationFixture({
			container: { memoryMb: 512, cpus: 1.5, pidsLimit: 128 },
			environment: {
				PATH: "/opt/homebrew/bin:/usr/bin",
				HOME: "/nowhere/host-home",
				TMPDIR: "/nowhere/host-tmp",
				LANG: "C",
				ALLOWED_VALUE: "visible",
			},
			toolHomeMode: "ro",
			argv: [join(scratchRoot("noop"), "unused")].slice(0, 0).concat(["/bin/sh", "-c", "echo hi"]),
		});
		expect(fixture.invocation.args).toEqual([
			"run",
			"--rm",
			"--network",
			"none",
			"--user",
			"1000:1000",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"--read-only",
			"--tmpfs",
			"/tmp:rw,nosuid,nodev,exec,mode=1777",
			"--memory",
			"512m",
			"--cpus",
			"1.5",
			"--pids-limit",
			"128",
			"-v",
			`${fixture.workspaceDir}:/workspace:rw`,
			"-v",
			`${fixture.scratchDir}:/scratch:rw`,
			"-v",
			`${fixture.toolHomeRoot}:/tools:ro`,
			"-e",
			`PATH=${CONTAINER_PATH}`,
			"-e",
			"HOME=/scratch/home",
			"-e",
			"TMPDIR=/tmp",
			"-e",
			"LANG=C",
			"-e",
			"TERM=dumb",
			"-e",
			"ALLOWED_VALUE=visible",
			"-w",
			"/workspace",
			"--entrypoint",
			"/bin/sh",
			PINNED,
			"-c",
			"echo hi",
		]);
	});

	it("denies the network with --network none and never hands over the host network namespace", () => {
		const denied = invocationFixture({ network: "deny" }).invocation.args;
		expect(flagValues(denied, "--network")).toEqual(["none"]);

		const allowed = invocationFixture({ network: "allow" }).invocation.args;
		expect(flagValues(allowed, "--network")).toEqual(["bridge"]);
		for (const args of [denied, allowed]) {
			expect(args).not.toContain("host");
			expect(args.join(" ")).not.toContain("--network host");
		}
	});

	it("omits limits that are not declared and drops the read-only rootfs only when asked", () => {
		const bare = invocationFixture().invocation.args;
		expect(bare).not.toContain("--memory");
		expect(bare).not.toContain("--cpus");
		expect(bare).not.toContain("--pids-limit");
		expect(bare).toContain("--read-only");
		expect(flagValues(bare, "--tmpfs")).toEqual(["/tmp:rw,nosuid,nodev,exec,mode=1777"]);

		const writable = invocationFixture({ container: { readOnlyRootfs: false } }).invocation.args;
		expect(writable).not.toContain("--read-only");
		expect(writable).not.toContain("--tmpfs");
	});

	it("always drops capabilities, forbids privilege escalation, and runs as a non-root uid", () => {
		const args = invocationFixture().invocation.args;
		expect(flagValues(args, "--cap-drop")).toEqual(["ALL"]);
		expect(flagValues(args, "--security-opt")).toEqual(["no-new-privileges"]);
		const user = flagValues(args, "--user")[0] as string;
		expect(user).toBe("1000:1000");

		// The default derives from the calling process and is never root.
		const derived = dockerBackend.invocation({
			policy: policy(),
			mounts: { workspaceDir: "/w", scratchDir: "/s" },
			network: "deny",
			environment: {},
			cwd: "/w",
			argv: ["/bin/true"],
			hostEnvironment: { PATH: "/usr/bin" },
		});
		expect(flagValues(derived.args, "--user")[0]).not.toMatch(/^0(:|$)/);
	});

	it("mounts the prepared tool home read-only for a call and read-write only for a setup step", () => {
		const call = invocationFixture({ toolHomeMode: "ro" });
		expect(call.invocation.args).toContain(`${call.toolHomeRoot}:/tools:ro`);

		const setup = invocationFixture({ toolHomeMode: "rw" });
		expect(setup.invocation.args).toContain(`${setup.toolHomeRoot}:/tools:rw`);

		const noTools = invocationFixture({ toolHomeRoot: "" });
		expect(noTools.invocation.args.join(" ")).not.toContain("/tools");
	});

	it("starts from an empty environment and never inherits the host's", () => {
		process.env[HOST_SECRET] = "must-not-leak";
		const args = invocationFixture({
			environment: {
				PATH: "/opt/homebrew/bin:/usr/bin",
				HOME: "/nowhere/home",
				TMPDIR: "/nowhere/tmp",
				LANG: "C",
				ALLOWED_VALUE: "visible",
			},
		}).invocation.args;
		expect(environmentMap(args)).toEqual({
			PATH: CONTAINER_PATH,
			HOME: "/scratch/home",
			TMPDIR: "/tmp",
			LANG: "C",
			TERM: "dumb",
			ALLOWED_VALUE: "visible",
		});
		expect(args.join(" ")).not.toContain(HOST_SECRET);
		expect(args.join(" ")).not.toContain("must-not-leak");
		// The host PATH is host environment: /opt/homebrew names nothing inside
		// the image and would be a leak for no benefit.
		expect(args.join(" ")).not.toContain("/opt/homebrew");
	});

	it("translates every model-visible path to a container path, mounts aside", () => {
		const root = scratchRoot("paths");
		const workspaceDir = join(root, "workspace");
		const scratchDir = join(root, "scratch");
		const toolHomeRoot = join(root, "tools");
		for (const path of [workspaceDir, scratchDir, toolHomeRoot]) mkdirSync(path, { recursive: true });
		const invocation = dockerBackend.invocation({
			policy: policy(),
			mounts: { workspaceDir, scratchDir, toolHomeRoot },
			network: "deny",
			environment: {
				HOME: join(scratchDir, "tool-home/lookup"),
				TMPDIR: join(scratchDir, "tool-tmp/lookup"),
				AHDE_TOOL_HOME: join(toolHomeRoot, "lookup"),
			},
			cwd: join(workspaceDir, "nested"),
			argv: [join(toolHomeRoot, "lookup/run"), join(workspaceDir, "data/input.json")],
			hostEnvironment: { PATH: "/usr/bin" },
		});
		expect(environmentMap(invocation.args)).toMatchObject({
			HOME: "/scratch/tool-home/lookup",
			TMPDIR: "/scratch/tool-tmp/lookup",
			AHDE_TOOL_HOME: "/tools/lookup",
		});
		expect(flagValues(invocation.args, "-w")).toEqual(["/workspace/nested"]);
		expect(flagValues(invocation.args, "--entrypoint")).toEqual(["/tools/lookup/run"]);
		expect(invocation.args.at(-1)).toBe("/workspace/data/input.json");
		// The only host spellings anywhere are the three `-v` mount sources.
		const hostMentions = invocation.args.filter((argument) => argument.includes(root));
		expect(hostMentions).toEqual([
			`${workspaceDir}:/workspace:rw`,
			`${scratchDir}:/scratch:rw`,
			`${toolHomeRoot}:/tools:ro`,
		]);
	});

	it("refuses a host path that is not mounted rather than leaking it into the container", () => {
		const root = scratchRoot("refuse");
		const workspaceDir = join(root, "workspace");
		const scratchDir = join(root, "scratch");
		mkdirSync(workspaceDir, { recursive: true });
		mkdirSync(scratchDir, { recursive: true });
		const build = (argv: string[], cwd = workspaceDir) =>
			dockerBackend.invocation({
				policy: policy(),
				mounts: { workspaceDir, scratchDir },
				network: "deny",
				environment: {},
				cwd,
				argv,
				hostEnvironment: { PATH: "/usr/bin" },
			});
		expect(() => build(["/private/var/secrets/key"])).toThrow(/refuses a host command outside the mounted roots/);
		expect(() => build(["/bin/sh", "/private/var/secrets/key"]))
			.toThrow(/refuses a host argument outside the mounted roots/);
		expect(() => build(["/bin/sh"], "/private/var/elsewhere")).toThrow(/refuses a host cwd outside the mounted roots/);
		// Absolute paths that name something inside the image pass through.
		expect(flagValues(build(["/bin/sh", "/etc/hosts"]).args, "--entrypoint")).toEqual(["/bin/sh"]);
	});

	it("gives the runtime CLI a host environment that carries no Target value", () => {
		process.env[HOST_SECRET] = "must-not-leak";
		const invocation = dockerBackend.invocation({
			policy: policy(),
			mounts: { workspaceDir: "/w", scratchDir: "/s" },
			network: "deny",
			environment: { ALLOWED_VALUE: "visible" },
			cwd: "/w",
			argv: ["/bin/true"],
			hostEnvironment: { PATH: "/usr/bin:/bin", HOME: "/host/home", DOCKER_HOST: "unix:///x.sock", [HOST_SECRET]: "must-not-leak" },
		});
		expect(invocation.spawnEnvironment).toEqual({
			PATH: "/usr/bin:/bin",
			HOME: "/host/home",
			DOCKER_HOST: "unix:///x.sock",
		});
	});

	it("refuses an image reference that could be read as a flag", () => {
		expect(() =>
			dockerBackend.invocation({
				policy: policy({ image: "--privileged" }),
				mounts: { workspaceDir: "/w", scratchDir: "/s" },
				network: "deny",
				environment: {},
				cwd: "/w",
				argv: ["/bin/true"],
				hostEnvironment: { PATH: "/usr/bin" },
			})
		).toThrow(/unsafe image reference/);
	});
});

describe("gondolin", () => {
	it("fails closed with the exact reason and vendors nothing", () => {
		expect(gondolinBackend.unavailable()).toEqual({
			runtime: "gondolin",
			available: false,
			reason: GONDOLIN_UNAVAILABLE,
		});
		expect(() => gondolinBackend.invocation({
			policy: policy({ runtime: "gondolin" }),
			mounts: { workspaceDir: "/w", scratchDir: "/s" },
			network: "deny",
			environment: {},
			cwd: "/w",
			argv: ["/bin/true"],
		})).toThrow(GONDOLIN_UNAVAILABLE);
		expect(detectContainerRuntime("gondolin", { force: true }).reason).toBe(GONDOLIN_UNAVAILABLE);
		expect(() =>
			resolveContainerSandbox({ policy: policy({ runtime: "gondolin" }), sandbox: "required" })
		).toThrow(new RegExp(GONDOLIN_UNAVAILABLE));
	});
});

describe("container runtime detection", () => {
	it("reads the server version from a real version probe and memoizes it per process", () => {
		const fake = fakeDocker({ version: "27.1.0" });
		const environment = { PATH: fake.binDir };
		const first = detectContainerRuntime("docker", { environment });
		expect(first).toEqual({ runtime: "docker", available: true, version: "27.1.0" });

		// Delete the binary: a second call must answer from the memo, never probe.
		rmSync(join(fake.binDir, "docker"));
		expect(detectContainerRuntime("docker", { environment })).toEqual(first);
		expect(detectContainerRuntime("docker", { environment, force: true }).available).toBe(false);
	});

	it("reports a missing binary and an unreachable daemon as distinct, exact reasons", () => {
		const empty = join(scratchRoot("empty-path"), "bin");
		mkdirSync(empty, { recursive: true });
		expect(detectContainerRuntime("docker", { environment: { PATH: empty } })).toEqual({
			runtime: "docker",
			available: false,
			reason: "docker executable not found on PATH",
		});

		const broken = fakeDocker({ failReason: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" });
		const status = detectContainerRuntime("docker", { environment: { PATH: broken.binDir } });
		expect(status.available).toBe(false);
		expect(status.reason).toBe(
			"docker daemon is not reachable: Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
		);
	});
});

describe("required / best-effort / off matrix", () => {
	const available: ContainerRuntimeStatus = { runtime: "docker", available: true, version: "27.1.0" };
	const missing: ContainerRuntimeStatus = { runtime: "docker", available: false, reason: "docker executable not found on PATH" };

	it("required + usable runtime + pinned digest runs in the container", () => {
		const decision = resolveContainerSandbox({ policy: policy(), sandbox: "required", detect: () => available });
		expect(decision.mode).toBe("container");
		expect(decision.warnings).toEqual([]);
		expect(decision.fingerprint).toBe(`container:docker@${DIGEST}`);
	});

	it("required + no usable runtime fails closed with the runtime's exact reason", () => {
		expect(() => resolveContainerSandbox({ policy: policy(), sandbox: "required", detect: () => missing }))
			.toThrow(
				"execution.container declares docker but no usable runtime is present; sandbox: required fails closed: docker executable not found on PATH",
			);
	});

	it("required refuses a mutable tag before it ever probes a runtime", () => {
		let probed = false;
		expect(() =>
			resolveContainerSandbox({
				policy: policy({ image: TAG }),
				sandbox: "required",
				detect: () => {
					probed = true;
					return available;
				},
			})
		).toThrow(/must be pinned to a digest \(name@sha256:…\) when sandbox: required/);
		expect(probed).toBe(false);
	});

	it("best-effort accepts a tag with a warning and a fingerprint that says it is a tag", () => {
		const decision = resolveContainerSandbox({
			policy: policy({ image: TAG }),
			sandbox: "best-effort",
			detect: () => available,
		});
		expect(decision.mode).toBe("container");
		expect(decision.fingerprint).toBe(`container:docker@${TAG}`);
		expect(decision.warnings).toHaveLength(1);
		expect(decision.warnings[0]).toContain("is a mutable tag, not a pinned digest");
	});

	it("best-effort falls back to the OS sandbox with a warning and a different fingerprint", () => {
		const decision = resolveContainerSandbox({ policy: policy(), sandbox: "best-effort", detect: () => missing });
		expect(decision.mode).toBe("fallback");
		expect(decision.fingerprint).toBeUndefined();
		expect(decision.warnings[0]).toContain("falling back to the host OS sandbox");
		expect(decision.warnings[0]).toContain("NOT container evidence");

		const choice = resolveExecutionBackend({
			policy: { sandbox: "best-effort", container: policy() },
			osBackend: () => "sandbox-exec" as const,
			detect: () => missing,
		});
		expect(choice.backend).toBe("sandbox-exec");
		expect(choice.sandboxFingerprint).toBe("sandbox-exec");
		expect(choice.sandboxFingerprint.startsWith("container:")).toBe(false);
	});

	it("sandbox: off cannot declare containment", () => {
		expect(() => resolveContainerSandbox({ policy: policy(), sandbox: "off", detect: () => available }))
			.toThrow(/sandbox: off declares no containment/);
	});

	it("computes one fingerprint per case", () => {
		expect(isPinnedContainerImage(PINNED)).toBe(true);
		expect(isPinnedContainerImage(TAG)).toBe(false);
		expect(containerImageDigest(PINNED)).toBe(DIGEST);
		expect(containerImageDigest(TAG)).toBeNull();
		expect(containerSandboxFingerprint(policy())).toBe(`container:docker@${DIGEST}`);
		expect(containerSandboxFingerprint(policy({ image: TAG }))).toBe(`container:docker@${TAG}`);
		expect(containerSandboxFingerprint(policy({ runtime: "gondolin" }))).toBe(`container:gondolin@${DIGEST}`);
		// The host backends keep their own values, so container evidence and host
		// evidence can never land in the same comparability class.
		expect(
			resolveExecutionBackend({ policy: { sandbox: "best-effort" }, osBackend: () => "sandbox-exec" as const })
				.sandboxFingerprint,
		).toBe("sandbox-exec");
	});
});

describe("manifest execution.container", () => {
	function targetFixture(executionBlock: string): string {
		const dir = makeTargetFixture(baseFixtureFiles({
			"manifest.yaml": `id: container-target
model:
  provider: test
  id: test-model
  api: openai-completions
  baseUrl: http://127.0.0.1:1/v1
  apiKeyEnv: TEST_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: 1000
${executionBlock}instructions:
  agentsMd: AGENTS.md
skills: []
evalSuite:
  id: container-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`,
		}));
		roots.push(dir);
		return dir;
	}

	const block = (options: { sandbox: string; image: string; extra?: string }) =>
		`execution:
  tools: [read, bash]
  environmentAllowlist: []
  network: deny
  sandbox: ${options.sandbox}
  container:
    runtime: docker
    image: ${options.image}
${options.extra ?? ""}`;

	it("loads a pinned container block with its defaults", () => {
		const target = loadTarget(targetFixture(block({ sandbox: "required", image: PINNED })));
		expect(target.manifest.execution.container).toEqual({
			runtime: "docker",
			image: PINNED,
			workdir: "/workspace",
			readOnlyRootfs: true,
		});
	});

	it("carries the declared limits through the schema", () => {
		const target = loadTarget(targetFixture(block({
			sandbox: "required",
			image: PINNED,
			extra: "    workdir: /workspace\n    memoryMb: 2048\n    cpus: 2\n    pidsLimit: 256\n    readOnlyRootfs: false\n",
		})));
		expect(target.manifest.execution.container).toMatchObject({
			memoryMb: 2048,
			cpus: 2,
			pidsLimit: 256,
			readOnlyRootfs: false,
		});
	});

	it("refuses a mutable tag under sandbox: required and accepts it under best-effort", () => {
		expect(() => loadTarget(targetFixture(block({ sandbox: "required", image: TAG }))))
			.toThrow(/must be pinned to a digest/);
		const relaxed = loadTarget(targetFixture(block({ sandbox: "best-effort", image: TAG })));
		expect(relaxed.manifest.execution.container?.image).toBe(TAG);
	});

	it("refuses a container block under sandbox: off and out-of-range limits", () => {
		expect(() => loadTarget(targetFixture(block({ sandbox: "off", image: PINNED }))))
			.toThrow(/sandbox: off declares no containment/);
		expect(() =>
			loadTarget(targetFixture(block({ sandbox: "required", image: PINNED, extra: "    memoryMb: 999999\n" })))
		).toThrow();
		expect(() =>
			loadTarget(targetFixture(block({ sandbox: "required", image: PINNED, extra: "    cpus: 0\n" })))
		).toThrow();
		expect(() =>
			loadTarget(targetFixture(block({ sandbox: "required", image: PINNED, extra: "    pidsLimit: 0\n" })))
		).toThrow();
	});
});

describe("the built-in bash under the container backend", () => {
	function fixture(options: { sandbox: "required" | "best-effort"; container?: Partial<ContainerPolicy>; detect?: () => ContainerRuntimeStatus }) {
		const root = scratchRoot("bash-container");
		const workspaceDir = join(root, "workspace");
		const scratchDir = join(root, "scratch");
		mkdirSync(workspaceDir, { recursive: true });
		mkdirSync(scratchDir, { recursive: true });
		return buildExecutionPolicy({
			workspaceDir,
			scratchDir,
			policy: {
				tools: ["bash"],
				environmentAllowlist: ["ALLOWED_VALUE"],
				network: "deny",
				sandbox: options.sandbox,
				container: policy(options.container ?? {}),
			},
			environment: {
				PATH: "/usr/bin:/bin",
				LANG: "C",
				HOME: join(scratchDir, "home"),
				TMPDIR: join(scratchDir, "tmp"),
			},
			sourceEnvironment: { ALLOWED_VALUE: "visible", [HOST_SECRET]: "must-not-leak" },
			...(options.detect ? { detectContainerRuntime: options.detect } : {}),
		});
	}

	it("records the container fingerprint and never claims a host OS sandbox", () => {
		const result = fixture({
			sandbox: "required",
			detect: () => ({ runtime: "docker", available: true, version: "27.1.0" }),
		});
		expect(result.sandboxFingerprint).toBe(`container:docker@${DIGEST}`);
		expect(result.sandboxBackend).toBe("none");
		expect(result.sandboxWarnings).toEqual([]);
		expect(result.customTools.map((tool) => tool.name)).toEqual(["bash"]);
	});

	it("fails closed at policy construction when required containment has no runtime", () => {
		expect(() =>
			fixture({
				sandbox: "required",
				detect: () => ({ runtime: "docker", available: false, reason: "docker daemon is not reachable: down" }),
			})
		).toThrow(/sandbox: required fails closed: docker daemon is not reachable: down/);
	});

	it("actually spawns the container runtime for a bash call instead of the host shell", async () => {
		const fake = fakeDocker({ version: "27.1.0" });
		const originalPath = process.env.PATH;
		process.env.PATH = fake.binDir;
		try {
			const result = fixture({
				sandbox: "required",
				detect: () => ({ runtime: "docker", available: true, version: "27.1.0" }),
			});
			const bash = result.customTools.find((tool) => tool.name === "bash");
			if (!bash) throw new Error("bash tool was not registered");
			await bash.execute("call-1", { command: "echo hi" }, undefined, undefined, undefined as never);
			const args = loggedArgv(fake.logPath);
			expect(args[0]).toBe("run");
			expect(args).toContain("--rm");
			expect(flagValues(args, "--network")).toEqual(["none"]);
			expect(flagValues(args, "-w")).toEqual(["/workspace"]);
			expect(flagValues(args, "--entrypoint")).toEqual(["/bin/sh"]);
			expect(args.slice(-3)).toEqual([PINNED, "-c", "echo hi"]);
			expect(environmentMap(args)).toEqual({
				PATH: CONTAINER_PATH,
				HOME: "/scratch/home",
				TMPDIR: "/scratch/tmp",
				LANG: "C",
				TERM: "dumb",
				ALLOWED_VALUE: "visible",
			});
			expect(args.join(" ")).not.toContain("must-not-leak");
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
		}
	});
});

describe("declared tool setup inside the container", () => {
	it("runs the setup step in the same container with the tool home mounted rw", () => {
		const fake = fakeDocker({ version: "27.1.0" });
		const originalPath = process.env.PATH;
		process.env.PATH = fake.binDir;
		const root = scratchRoot("setup-container");
		const workspaceDir = join(root, "workspace");
		const scratchDir = join(root, "scratch");
		const toolHomeRoot = join(root, "tool-home");
		mkdirSync(join(workspaceDir, "tools/lookup"), { recursive: true });
		mkdirSync(scratchDir, { recursive: true });
		writeFileSync(join(workspaceDir, "tools/lookup/run"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(workspaceDir, "tools/lookup/run"), 0o755);
		try {
			const prepared = prepareToolHome({
				workspaceDir,
				scratchDir,
				toolHomeRoot,
				policy: {
					environmentAllowlist: [],
					network: "deny",
					sandbox: "required",
					container: policy(),
				},
				sandboxBackend: "container",
				tools: [resolvedDirectoryTool(workspaceDir)],
			});
			expect(prepared.setups.map((setup) => ({ tool: setup.tool, ran: setup.ran, exitCode: setup.exitCode })))
				.toEqual([{ tool: "lookup", ran: true, exitCode: 0 }]);
			const args = loggedArgv(fake.logPath);
			expect(args).toContain(`${toolHomeRoot}:/tools:rw`);
			expect(flagValues(args, "-w")).toEqual(["/tools/lookup"]);
			expect(args).toContain(PINNED);
			// The setup command resolves inside the image, so no host PATH lookup
			// baked a host path into the argv.
			expect(flagValues(args, "--entrypoint")).toEqual(["/bin/sh"]);
			expect(environmentMap(args)).toMatchObject({ AHDE_TOOL_HOME: "/tools/lookup" });
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
		}
	});
});

/** A minimal resolved directory tool with a declared setup step. */
function resolvedDirectoryTool(workspaceDir: string) {
	const runPath = join(workspaceDir, "tools/lookup/run");
	const content = readFileSync(runPath);
	const hash = hashFile(content.toString("base64"));
	return {
		descriptor: {
			schemaVersion: 1 as const,
			name: "lookup",
			description: "test",
			parameters: { type: "object" as const, properties: {}, additionalProperties: false as const },
			command: { argv: ["tools/lookup/run"] },
			timeoutMs: 10_000,
			maxOutputBytes: 8_192,
			output: "text" as const,
			permissions: { environment: [], network: "deny" as const, filesystem: "read-only" as const },
			lockfiles: [],
			setup: { argv: ["/bin/sh", "-c", "true"], timeoutMs: 20_000, network: "deny" as const },
		},
		descriptorPath: "tools/lookup/tool.yaml",
		executablePath: "tools/lookup/run",
		executableHash: hash,
		digest: hash,
		layout: "directory" as const,
		directoryPath: "tools/lookup",
		files: [{
			path: "run",
			sha256: hash,
			executable: true,
			bytes: content.byteLength,
		}],
	} as unknown as Parameters<typeof prepareToolHome>[0]["tools"][number];
}

describe("ahde validate readiness line", () => {
	it("names the runtime, its version, and whether the image is pinned", () => {
		const fake = fakeDocker({ version: "27.1" });
		expect(describeSandboxReadiness(
			{ sandbox: "required", container: policy() },
			{ environment: { PATH: fake.binDir } },
		)).toEqual({ line: "sandbox: container (docker 27.1, image pinned)", failClosed: false });

		resetContainerRuntimeDetection();
		expect(describeSandboxReadiness(
			{ sandbox: "best-effort", container: policy({ image: TAG }) },
			{ environment: { PATH: fake.binDir } },
		).line).toBe("sandbox: container (docker 27.1, image UNPINNED tag)");
	});

	it("prints the fail-closed reason instead of a readiness claim", () => {
		const empty = join(scratchRoot("no-docker"), "bin");
		mkdirSync(empty, { recursive: true });
		const readiness = describeSandboxReadiness(
			{ sandbox: "required", container: policy() },
			{ environment: { PATH: empty } },
		);
		expect(readiness.failClosed).toBe(true);
		expect(readiness.line).toBe(
			"sandbox: FAIL CLOSED — execution.container declares docker but no usable runtime is present; sandbox: required fails closed: docker executable not found on PATH",
		);
	});

	it("says a best-effort fallback is not container evidence, and stays silent without a container block", () => {
		const empty = join(scratchRoot("no-docker-2"), "bin");
		mkdirSync(empty, { recursive: true });
		const fallback = describeSandboxReadiness(
			{ sandbox: "best-effort", container: policy() },
			{ environment: { PATH: empty } },
		);
		expect(fallback.failClosed).toBe(false);
		expect(fallback.line).toContain("NOT container evidence");

		expect(describeSandboxReadiness({ sandbox: "best-effort" }))
			.toEqual({ line: "sandbox: best-effort (host OS sandbox)", failClosed: false });
	});
});

// ---------- integration: a real container, or an explicit skip ----------

const dockerStatus = detectContainerRuntime("docker", { force: true });
const INTEGRATION_IMAGE = "busybox:latest";

function localImage(): string | null {
	if (!dockerStatus.available) return null;
	const inspect = spawnSync("docker", ["image", "inspect", INTEGRATION_IMAGE], { stdio: "ignore", timeout: 30_000 });
	if (inspect.status === 0) return INTEGRATION_IMAGE;
	const pull = spawnSync("docker", ["pull", "--quiet", INTEGRATION_IMAGE], { stdio: "ignore", timeout: 180_000 });
	return pull.status === 0 ? INTEGRATION_IMAGE : null;
}

const integrationImage = localImage();
const skipReason = dockerStatus.available
	? (integrationImage ? "" : ` — SKIPPED: docker ${dockerStatus.version} is up but ${INTEGRATION_IMAGE} is neither local nor pullable`)
	: ` — SKIPPED: ${dockerStatus.reason}`;
if (skipReason) console.warn(`[container-backend integration]${skipReason}`);

describe.skipIf(!integrationImage)(`container backend integration (real docker)${skipReason}`, () => {
	it("runs the declared argv inside the container, sees only container paths, and inherits no host environment", () => {
		process.env[HOST_SECRET] = "must-not-leak";
		const root = scratchRoot("integration");
		const workspaceDir = join(root, "workspace");
		const scratchDir = join(root, "scratch");
		mkdirSync(workspaceDir, { recursive: true });
		mkdirSync(join(scratchDir, "home"), { recursive: true });
		writeFileSync(join(workspaceDir, "hello.txt"), "workspace-bytes\n");

		const invocation = dockerBackend.invocation({
			policy: policy({ image: integrationImage as string, memoryMb: 256, pidsLimit: 64 }),
			mounts: { workspaceDir, scratchDir },
			network: "deny",
			environment: { HOME: join(scratchDir, "home"), LANG: "C", ALLOWED_VALUE: "visible" },
			cwd: workspaceDir,
			argv: [
				"/bin/sh",
				"-c",
				`printf '%s|%s|%s|%s' "$PWD" "$(cat hello.txt | tr -d '\\n')" "$ALLOWED_VALUE" "\${${HOST_SECRET}-unset}"`,
			],
		});
		const result = spawnSync(invocation.executable, invocation.args, {
			encoding: "utf8",
			env: invocation.spawnEnvironment,
			timeout: 120_000,
		});
		expect(result.stderr ?? "").not.toMatch(/Error response from daemon/);
		expect(result.status).toBe(0);
		expect(result.stdout.trim()).toBe("/workspace|workspace-bytes|visible|unset");
	});

	it("denies the network inside the container and can write the mounted workspace", () => {
		const root = scratchRoot("integration-net");
		const workspaceDir = join(root, "workspace");
		const scratchDir = join(root, "scratch");
		mkdirSync(workspaceDir, { recursive: true });
		mkdirSync(scratchDir, { recursive: true });

		const run = (network: "deny" | "allow", command: string) => {
			const invocation = dockerBackend.invocation({
				policy: policy({ image: integrationImage as string }),
				mounts: { workspaceDir, scratchDir },
				network,
				environment: {},
				cwd: workspaceDir,
				argv: ["/bin/sh", "-c", command],
			});
			return spawnSync(invocation.executable, invocation.args, {
				encoding: "utf8",
				env: invocation.spawnEnvironment,
				timeout: 120_000,
			});
		};
		// `--network none` leaves only loopback; no route to any address exists.
		const denied = run("deny", "ip route 2>/dev/null | grep -q default && echo routed || echo no-route");
		expect(denied.status).toBe(0);
		expect(denied.stdout.trim()).toBe("no-route");

		const wrote = run("deny", "printf container-wrote > /workspace/out.txt && echo ok");
		expect(wrote.status).toBe(0);
		expect(readFileSync(join(workspaceDir, "out.txt"), "utf8")).toBe("container-wrote");

		// The root filesystem is read-only; only /tmp and the mounts are writable.
		const readOnly = run("deny", "touch /etc/ahde-probe 2>/dev/null && echo writable || echo read-only");
		expect(readOnly.stdout.trim()).toBe("read-only");
	});
});
