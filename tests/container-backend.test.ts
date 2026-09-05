import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildExecutionPolicy } from "../src/execution-policy.js";
import { loadTarget } from "../src/manifest.js";
import { hashFile } from "../src/provenance.js";
import {
	assertContainerRuntimeBinding,
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
	type ContainerRuntimeIdentity,
	type ContainerRuntimeStatus,
} from "../src/target/container-backend.js";
import { prepareToolHome } from "../src/target/tool-setup.js";
import { effectiveTargetSandbox, targetFilesystemConfinement } from "../src/target/runtime.js";
import {
	AUTHORING_RESOURCE_LIMITS,
	sandboxInvocation as targetSandboxInvocation,
} from "../src/target/tool-broker.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const PINNED = `registry.example.com/ahde/target@${DIGEST}`;
const TAG = "registry.example.com/ahde/target:1.2.3";
const PLATFORM = "linux/amd64";
const RUNTIME_IDENTITY = {
	version: "27.1.0",
	os: "linux",
	arch: "amd64",
	daemonId: "daemon-test-id",
	kernelVersion: "6.10.0-test",
	driver: "overlay2",
	cgroupDriver: "cgroupfs",
	cgroupVersion: "2",
	securityOptionsHash: "b".repeat(64),
	contextHash: "c".repeat(64),
} as const;
/** One probed runtime that named its server exactly. */
function availableStatus(identity: ContainerRuntimeIdentity = RUNTIME_IDENTITY): ContainerRuntimeStatus {
	return { runtime: "docker", available: true, identity };
}
const EXPECTED_CONTAINER_USER = typeof process.getuid === "function" && process.getuid() !== 0
	? `${process.getuid()}:${typeof process.getgid === "function" ? process.getgid() : 0}`
	: "65534:65534";
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
		platform: PLATFORM,
		readOnlyRootfs: true,
		...overrides,
	};
}

/**
 * A `docker` on PATH that answers the version probe exactly the way the real
 * client does, and records every later invocation's argv. Nothing here needs a
 * daemon: the point is the argv the harness constructs.
 */
function fakeDocker(options: {
	version?: string;
	failReason?: string;
	logPath?: string;
	hangRun?: boolean;
	failCleanup?: boolean;
	inspectLabelsFile?: string;
	infoFile?: string;
} = {}): {
	binDir: string;
	logPath: string;
} {
	const binDir = join(scratchRoot("fake-docker"), "bin");
	mkdirSync(binDir, { recursive: true });
	const logPath = options.logPath ?? join(binDir, "..", "docker-argv.log");
	const versionBranch = options.failReason
		? `printf '%s\\n' ${JSON.stringify(options.failReason)} >&2; exit 1`
		: `printf '%s|%s|%s\\n' ${JSON.stringify(options.version ?? "27.1.0")} linux amd64`;
	const script = `#!/bin/sh
if [ "$1" = "version" ]; then
${versionBranch}
fi
if [ "$1" = "info" ]; then
${options.infoFile ? `  /bin/cat ${JSON.stringify(options.infoFile)}
  exit 0` : `
  printf '%s\n' '${JSON.stringify({
	ID: RUNTIME_IDENTITY.daemonId,
	KernelVersion: RUNTIME_IDENTITY.kernelVersion,
	Driver: RUNTIME_IDENTITY.driver,
	CgroupDriver: RUNTIME_IDENTITY.cgroupDriver,
	CgroupVersion: RUNTIME_IDENTITY.cgroupVersion,
	SecurityOptions: ["name=seccomp,profile=builtin"],
  })}'
  exit 0`}
fi
${options.inspectLabelsFile ? `if [ "$1" = "inspect" ]; then
  if [ -f ${JSON.stringify(options.inspectLabelsFile)} ]; then /bin/cat ${JSON.stringify(options.inspectLabelsFile)}; exit 0; fi
  printf 'No such container\\n' >&2
  exit 1
fi` : ""}
: > ${JSON.stringify(logPath)}
previous=''
for argument in "$@"; do
  printf '%s\\n' "$argument" >> ${JSON.stringify(logPath)}
  if [ "$previous" = "--env-file" ] && [ -f "$argument" ]; then
    while IFS= read -r line; do printf 'ENV:%s\\n' "$line" >> ${JSON.stringify(logPath)}; done < "$argument"
  fi
  previous="$argument"
done
${options.hangRun ? 'if [ "$1" = "run" ]; then while :; do :; done; fi' : ""}
${options.failCleanup ? 'if [ "$1" = "rm" ]; then printf \'daemon cleanup refused\\n\' >&2; exit 1; fi' : ""}
${options.inspectLabelsFile ? `if [ "$1" = "rm" ]; then /bin/rm -f ${JSON.stringify(options.inspectLabelsFile)}; fi` : ""}
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

function boundFakeDocker(fake: ReturnType<typeof fakeDocker>) {
	const status = detectContainerRuntime("docker", { environment: { PATH: fake.binDir }, force: true });
	const choice = resolveExecutionBackend({
		policy: { sandbox: "required" as const, container: policy() },
		osBackend: () => "sandbox-exec" as const,
		detect: () => status,
	});
	if (!choice.containerRuntime) throw new Error("fake Docker probe returned no runtime binding");
	return choice.containerRuntime;
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
	const path = flagValues(args, "--env-file")[0];
	let entries: string[] | null = null;
	if (path) {
		try {
			entries = readFileSync(path, "utf8").split("\n").filter(Boolean);
		} catch {
			// Runtime tests inspect argv after the invocation disposed its private
			// env-file; the fake client copied only its non-secret test contents.
		}
	}
	for (const entry of entries ?? args.filter((argument) => argument.startsWith("ENV:")).map((argument) => argument.slice(4))) {
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
		workspaceMode?: "ro" | "rw";
	argv?: string[];
		cwd?: string;
		containerName?: string;
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
				...(overrides.workspaceMode ? { workspaceMode: overrides.workspaceMode } : {}),
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
			containerName: overrides.containerName ?? "ahde-test",
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
		const environmentFile = flagValues(fixture.invocation.args, "--env-file")[0] as string;
		const cidFile = flagValues(fixture.invocation.args, "--cidfile")[0] as string;
		const labels = flagValues(fixture.invocation.args, "--label");
		expect(cidFile).toMatch(/ahde-container-lifecycle-[^/]+\/container\.cid$/);
		expect(labels).toHaveLength(4);
		expect(labels).toContain("com.ahde.managed=true");
		expect(labels).toContain("com.ahde.expires-at-ms=unbounded");
		expect(labels.find((label) => label.startsWith("com.ahde.owner="))).toMatch(/=[0-9a-f]{64}$/);
		expect(labels.find((label) => label.startsWith("com.ahde.session="))).toMatch(/=[0-9a-f-]{36}$/);
		expect(fixture.invocation.args).toEqual([
			"run",
			"--rm",
			"--name",
			"ahde-test",
			"--cidfile",
			cidFile,
			...labels.flatMap((label) => ["--label", label]),
			"--platform",
			PLATFORM,
			"--network",
			"none",
			"--user",
			EXPECTED_CONTAINER_USER,
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
			"--env-file",
			environmentFile,
			"-w",
			"/workspace",
			"--entrypoint",
			"/bin/sh",
			PINNED,
			"-c",
			"echo hi",
		]);
		expect(environmentMap(fixture.invocation.args)).toEqual({
			PATH: CONTAINER_PATH,
			HOME: "/scratch/home",
			TMPDIR: "/tmp",
			LANG: "C",
			TERM: "dumb",
			ALLOWED_VALUE: "visible",
		});
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
		expect(user).toBe(EXPECTED_CONTAINER_USER);

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

	it("mounts the workspace read-only unless the caller grants workspace writes", () => {
		const readOnly = invocationFixture({ workspaceMode: "ro" });
		expect(readOnly.invocation.args).toContain(`${readOnly.workspaceDir}:/workspace:ro`);

		const writable = invocationFixture({ workspaceMode: "rw" });
		expect(writable.invocation.args).toContain(`${writable.workspaceDir}:/workspace:rw`);
	});

	it("starts from an empty environment and never inherits the host's", () => {
		process.env[HOST_SECRET] = "must-not-leak";
		const fixture = invocationFixture({
			environment: {
				PATH: "/opt/homebrew/bin:/usr/bin",
				HOME: "/nowhere/home",
				TMPDIR: "/nowhere/tmp",
				LANG: "C",
				ALLOWED_VALUE: "visible",
			},
		});
		const args = fixture.invocation.args;
		expect(environmentMap(args)).toEqual({
			PATH: CONTAINER_PATH,
			HOME: "/scratch/home",
			TMPDIR: "/tmp",
			LANG: "C",
			TERM: "dumb",
			ALLOWED_VALUE: "visible",
		});
		expect(args.join("\0")).not.toContain(HOST_SECRET);
		expect(args.join("\0")).not.toContain("must-not-leak");
		expect(args.join("\0")).not.toContain("ALLOWED_VALUE=visible");
		const environmentFile = flagValues(args, "--env-file")[0] as string;
		expect(statSync(environmentFile).mode & 0o777).toBe(0o600);
		fixture.invocation.dispose?.();
		expect(existsSync(environmentFile)).toBe(false);
		// The host PATH is host environment: /opt/homebrew names nothing inside
		// the image and would be a leak for no benefit.
		expect(args.join(" ")).not.toContain("/opt/homebrew");
	});

	it("refuses env-file record injection before the runtime can start", () => {
		expect(() => invocationFixture({ environment: { "SAFE\nINJECTED": "value" } }))
			.toThrow(/unsafe environment name/);
		expect(() => invocationFixture({ environment: { SAFE: "value\nINJECTED=secret" } }))
			.toThrow(/multiline or NUL value for SAFE/);
		expect(() => invocationFixture({ environment: { SAFE: "value\0secret" } }))
			.toThrow(/multiline or NUL value for SAFE/);
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
		expect(() => invocationFixture({ container: { image: TAG } }))
			.toThrow(/refuses a mutable image/);
		expect(() => invocationFixture({ container: { platform: "--privileged" } }))
			.toThrow(/unsafe platform/);
	});

	it("keeps authoring resource caps inside a container invocation", () => {
		const fixture = invocationFixture();
		const invocation = targetSandboxInvocation({
			backend: "container",
			workspaceDir: fixture.workspaceDir,
			scratchDir: fixture.scratchDir,
			environment: {},
			confinement: { network: "deny", readRoots: [], writeRoots: [] },
			cwd: fixture.workspaceDir,
			argv: [join(fixture.workspaceDir, "tools/run")],
			container: policy(),
			limits: AUTHORING_RESOURCE_LIMITS,
		});
		expect(invocation.limits?.limits).toEqual(AUTHORING_RESOURCE_LIMITS);
		expect(flagValues(invocation.args, "--entrypoint")).toEqual(["/bin/sh"]);
		expect(invocation.args).toContain("/workspace/tools/run");
		expect(invocation.terminate).toBeTypeOf("function");
	});

	it("mints a bounded name and exposes a daemon-side force-remove hook", () => {
		const fake = fakeDocker();
		const runtimeBinding = boundFakeDocker(fake);
		const fixture = invocationFixture({ containerName: "ahde-cleanup-test" });
		const invocation = dockerBackend.invocation({
			policy: policy(),
			mounts: { workspaceDir: fixture.workspaceDir, scratchDir: fixture.scratchDir },
			network: "deny",
			environment: {},
			cwd: fixture.workspaceDir,
			argv: ["/bin/true"],
			containerName: "ahde-cleanup-test",
			hostEnvironment: { PATH: fake.binDir },
			runtimeBinding,
		});
		expect(flagValues(invocation.args, "--name")).toEqual(["ahde-cleanup-test"]);
		invocation.terminate?.();
		expect(loggedArgv(fake.logPath)).toEqual(["rm", "-f", "ahde-cleanup-test"]);
		expect(() => invocationFixture({ containerName: "unsafe/name" })).toThrow(/unsafe container name/);
	});

	it("fails closed when the daemon cannot confirm container removal", () => {
		const fake = fakeDocker({ failCleanup: true });
		const runtimeBinding = boundFakeDocker(fake);
		const fixture = invocationFixture({ containerName: "ahde-cleanup-failure" });
		const invocation = dockerBackend.invocation({
			policy: policy(),
			mounts: { workspaceDir: fixture.workspaceDir, scratchDir: fixture.scratchDir },
			network: "deny",
			environment: {},
			cwd: fixture.workspaceDir,
			argv: ["/bin/true"],
			containerName: "ahde-cleanup-failure",
			hostEnvironment: { PATH: fake.binDir },
			runtimeBinding,
		});
		const environmentFile = flagValues(invocation.args, "--env-file")[0] as string;
		try {
			expect(() => invocation.terminate?.()).toThrow(
				/failed to remove container ahde-cleanup-failure after 8 attempts: daemon cleanup refused/,
			);
			expect(existsSync(environmentFile)).toBe(false);
		} finally {
			rmSync(dirname(environmentFile), { recursive: true, force: true });
		}
	});

	it("recovers only an expired, exactly labelled crash orphan from its private journal", () => {
		const labelState = join(scratchRoot("recovery-labels"), "labels.json");
		const fake = fakeDocker({ inspectLabelsFile: labelState });
		const runtimeBinding = boundFakeDocker(fake);
		const fixture = invocationFixture();
		const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
		const first = dockerBackend.invocation({
			policy: policy(),
			mounts: { workspaceDir: fixture.workspaceDir, scratchDir: fixture.scratchDir },
			network: "deny",
			environment: {},
			cwd: fixture.workspaceDir,
			argv: ["/bin/true"],
			containerName: "ahde-recover-exact",
			runtimeBinding,
			lifecycleTimeoutMs: 100,
		});
		const firstRoot = dirname(flagValues(first.args, "--cidfile")[0] as string);
		const labels = Object.fromEntries(
			flagValues(first.args, "--label").map((label) => {
				const split = label.indexOf("=");
				return [label.slice(0, split), label.slice(split + 1)];
			}),
		);
		writeFileSync(labelState, `${JSON.stringify(labels)}\n`);
		clock.mockReturnValue(1_800_000_020_000);
		const second = dockerBackend.invocation({
			policy: policy(),
			mounts: { workspaceDir: fixture.workspaceDir, scratchDir: fixture.scratchDir },
			network: "deny",
			environment: {},
			cwd: fixture.workspaceDir,
			argv: ["/bin/true"],
			runtimeBinding,
		});
		try {
			second.assertReady?.();
			expect(loggedArgv(fake.logPath)).toEqual(["rm", "-f", "ahde-recover-exact"]);
			expect(existsSync(firstRoot)).toBe(false);
		} finally {
			second.dispose?.();
			clock.mockRestore();
			rmSync(firstRoot, { recursive: true, force: true });
		}
	});

	it("refuses recovery when a container's ownership labels do not match the journal", () => {
		const labelState = join(scratchRoot("recovery-label-mismatch"), "labels.json");
		const fake = fakeDocker({ inspectLabelsFile: labelState });
		const runtimeBinding = boundFakeDocker(fake);
		const fixture = invocationFixture();
		const clock = vi.spyOn(Date, "now").mockReturnValue(1_900_000_000_000);
		const first = dockerBackend.invocation({
			policy: policy(),
			mounts: { workspaceDir: fixture.workspaceDir, scratchDir: fixture.scratchDir },
			network: "deny",
			environment: {},
			cwd: fixture.workspaceDir,
			argv: ["/bin/true"],
			containerName: "ahde-recover-mismatch",
			runtimeBinding,
			lifecycleTimeoutMs: 100,
		});
		const firstRoot = dirname(flagValues(first.args, "--cidfile")[0] as string);
		const labels = Object.fromEntries(
			flagValues(first.args, "--label").map((label) => {
				const split = label.indexOf("=");
				return [label.slice(0, split), label.slice(split + 1)];
			}),
		);
		labels["com.ahde.session"] = "00000000-0000-0000-0000-000000000000";
		writeFileSync(labelState, `${JSON.stringify(labels)}\n`);
		clock.mockReturnValue(1_900_000_020_000);
		const second = dockerBackend.invocation({
			policy: policy(),
			mounts: { workspaceDir: fixture.workspaceDir, scratchDir: fixture.scratchDir },
			network: "deny",
			environment: {},
			cwd: fixture.workspaceDir,
			argv: ["/bin/true"],
			runtimeBinding,
		});
		try {
			expect(() => second.assertReady?.()).toThrow(/ownership labels do not match/);
			expect(existsSync(labelState)).toBe(true);
			expect(existsSync(firstRoot)).toBe(true);
		} finally {
			second.dispose?.();
			clock.mockRestore();
			rmSync(firstRoot, { recursive: true, force: true });
		}
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
		const gondolin = detectContainerRuntime("gondolin", { force: true });
		if (gondolin.available) throw new Error("gondolin is not vendored and can never be available");
		expect(gondolin.reason).toBe(GONDOLIN_UNAVAILABLE);
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
		expect(first).toMatchObject({
			runtime: "docker",
			available: true,
			identity: {
				version: RUNTIME_IDENTITY.version,
				os: RUNTIME_IDENTITY.os,
				arch: RUNTIME_IDENTITY.arch,
				daemonId: RUNTIME_IDENTITY.daemonId,
				kernelVersion: RUNTIME_IDENTITY.kernelVersion,
				driver: RUNTIME_IDENTITY.driver,
				cgroupDriver: RUNTIME_IDENTITY.cgroupDriver,
				cgroupVersion: RUNTIME_IDENTITY.cgroupVersion,
				contextHash: expect.stringMatching(/^[0-9a-f]{64}$/),
				securityOptionsHash: expect.stringMatching(/^[0-9a-f]{64}$/),
			},
		});

		// Delete the binary: a second call must answer from the memo, never probe.
		rmSync(join(fake.binDir, "docker"));
		expect(detectContainerRuntime("docker", { environment })).toEqual(first);
		expect(detectContainerRuntime("docker", { environment, force: true }).available).toBe(false);
	});

	it("keeps Docker contexts in separate cache and evidence identities", () => {
		const fake = fakeDocker({ version: "27.1.0" });
		const first = detectContainerRuntime("docker", {
			environment: { PATH: fake.binDir, DOCKER_CONTEXT: "review-a" },
		});
		const second = detectContainerRuntime("docker", {
			environment: { PATH: fake.binDir, DOCKER_CONTEXT: "review-b" },
		});
		if (!first.available || !second.available) throw new Error("the fake Docker probe reported no runtime");
		expect(first.identity.contextHash).not.toBe(second.identity.contextHash);
		expect(containerSandboxFingerprint(policy(), first.identity))
			.not.toBe(containerSandboxFingerprint(policy(), second.identity));
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
		if (status.available) throw new Error("a broken daemon must not report an available runtime");
		expect(status.reason).toBe(
			"docker daemon is not reachable: Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
		);
	});

	it("refuses a blank daemon id at the probe, so no identity is ever minted from it", () => {
		const infoFile = join(scratchRoot("blank-daemon"), "info.json");
		writeFileSync(
			infoFile,
			`${JSON.stringify({
				ID: "   ",
				KernelVersion: RUNTIME_IDENTITY.kernelVersion,
				Driver: RUNTIME_IDENTITY.driver,
				CgroupDriver: RUNTIME_IDENTITY.cgroupDriver,
				CgroupVersion: RUNTIME_IDENTITY.cgroupVersion,
				SecurityOptions: ["name=seccomp,profile=builtin"],
			})}\n`,
		);
		const blank = fakeDocker({ infoFile });
		const status = detectContainerRuntime("docker", { environment: { PATH: blank.binDir }, force: true });
		if (status.available) throw new Error("a whitespace-only daemon id must not be an available runtime");
		expect(status.reason).toBe("docker daemon identity is incomplete");
	});
});

describe("required / best-effort / off matrix", () => {
	const available: ContainerRuntimeStatus = availableStatus();
	const missing: ContainerRuntimeStatus = { runtime: "docker", available: false, reason: "docker executable not found on PATH" };

	it("required + usable runtime + pinned digest runs in the container", () => {
		const decision = resolveContainerSandbox({ policy: policy(), sandbox: "required", detect: () => available });
		if (decision.mode !== "container") throw new Error("a usable runtime must confine the run");
		expect(decision.warnings).toEqual([]);
		expect(decision.fingerprint).toBe(containerSandboxFingerprint(policy(), RUNTIME_IDENTITY));
	});

	it("required + no usable runtime fails closed with the runtime's exact reason", () => {
		expect(() => resolveContainerSandbox({ policy: policy(), sandbox: "required", detect: () => missing }))
			.toThrow(
				"execution.container declares docker but no usable runtime is present; sandbox: required fails closed: docker executable not found on PATH",
			);
	});

	it("every policy refuses a mutable tag before it ever probes a runtime", () => {
		let probed = false;
		expect(() =>
			resolveContainerSandbox({
				policy: policy({ image: TAG }),
				sandbox: "best-effort",
				detect: () => {
					probed = true;
					return available;
				},
			})
		).toThrow(/must be pinned to a digest \(name@sha256:…\); mutable tags cannot identify comparable evidence/);
		expect(probed).toBe(false);
	});

	it("best-effort falls back to the OS sandbox with a warning and a different fingerprint", () => {
		const decision = resolveContainerSandbox({ policy: policy(), sandbox: "best-effort", detect: () => missing });
		expect(decision.mode).toBe("fallback");
		// A fallback carries no fingerprint field at all: the type says so, and
		// so does the object, which is what keeps it out of container evidence.
		expect(decision).not.toHaveProperty("fingerprint");
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

	it("refuses container evidence when the runtime cannot identify its server exactly", () => {
		const blank = availableStatus({ ...RUNTIME_IDENTITY, daemonId: "   " });
		expect(() => resolveContainerSandbox({ policy: policy(), sandbox: "required", detect: () => blank }))
			.toThrow(/did not report an exact daemon, context, kernel, cgroup, and server identity/);
		const relaxed = resolveContainerSandbox({ policy: policy(), sandbox: "best-effort", detect: () => blank });
		expect(relaxed.mode).toBe("fallback");
		expect(relaxed.warnings[0]).toContain("falling back to the host OS sandbox");
	});

	it("refuses a whitespace-only daemon id on the evidence path and the binding path alike", () => {
		// These two used to disagree: the fingerprint path required a non-blank
		// trimmed value, the binding assertion accepted any non-empty string.
		const blank = availableStatus({ ...RUNTIME_IDENTITY, daemonId: " " });
		expect(() => resolveContainerSandbox({ policy: policy(), sandbox: "required", detect: () => blank }))
			.toThrow(/did not report an exact daemon, context, kernel, cgroup, and server identity/);

		const infoFile = join(scratchRoot("blanked-daemon"), "info.json");
		const info = (id: string): string => `${JSON.stringify({
			ID: id,
			KernelVersion: RUNTIME_IDENTITY.kernelVersion,
			Driver: RUNTIME_IDENTITY.driver,
			CgroupDriver: RUNTIME_IDENTITY.cgroupDriver,
			CgroupVersion: RUNTIME_IDENTITY.cgroupVersion,
			SecurityOptions: ["name=seccomp,profile=builtin"],
		})}\n`;
		writeFileSync(infoFile, info(RUNTIME_IDENTITY.daemonId));
		const binding = boundFakeDocker(fakeDocker({ infoFile }));
		// The same socket now answers with a daemon that cannot name itself.
		writeFileSync(infoFile, info(" "));
		expect(() => assertContainerRuntimeBinding(binding))
			.toThrow(/container runtime changed after resolution.*docker daemon identity is incomplete/);
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
		expect(containerSandboxFingerprint(policy(), RUNTIME_IDENTITY)).toMatch(
			new RegExp(`^container:docker@${DIGEST}:config:[0-9a-f]{64}$`),
		);
		expect(() => containerSandboxFingerprint(policy({ image: TAG }), RUNTIME_IDENTITY))
			.toThrow(/mutable tags cannot identify comparable evidence/);
		expect(containerSandboxFingerprint(policy({ runtime: "gondolin" }), RUNTIME_IDENTITY))
			.toMatch(new RegExp(`^container:gondolin@${DIGEST}:config:[0-9a-f]{64}$`));
		expect(containerSandboxFingerprint(policy({ memoryMb: 512 }), RUNTIME_IDENTITY))
			.not.toBe(containerSandboxFingerprint(policy(), RUNTIME_IDENTITY));
		expect(containerSandboxFingerprint(policy({ platform: "linux/arm64" }), RUNTIME_IDENTITY))
			.not.toBe(containerSandboxFingerprint(policy(), RUNTIME_IDENTITY));
		expect(containerSandboxFingerprint(policy(), { ...RUNTIME_IDENTITY, version: "28.0.0" }))
			.not.toBe(containerSandboxFingerprint(policy(), RUNTIME_IDENTITY));
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
    platform: ${PLATFORM}
${options.extra ?? ""}`;

	it("loads a pinned container block with its defaults", () => {
		const target = loadTarget(targetFixture(block({ sandbox: "required", image: PINNED })));
		expect(target.manifest.execution.container).toEqual({
			runtime: "docker",
			image: PINNED,
			platform: PLATFORM,
			readOnlyRootfs: true,
		});
	});

	it("carries the declared limits through the schema", () => {
		const target = loadTarget(targetFixture(block({
			sandbox: "required",
			image: PINNED,
			extra: "    memoryMb: 2048\n    cpus: 2\n    pidsLimit: 256\n    readOnlyRootfs: false\n",
		})));
		expect(target.manifest.execution.container).toMatchObject({
			memoryMb: 2048,
			cpus: 2,
			pidsLimit: 256,
			readOnlyRootfs: false,
		});
	});

	it("refuses a mutable tag under both required and best-effort", () => {
		expect(() => loadTarget(targetFixture(block({ sandbox: "required", image: TAG }))))
			.toThrow(/must be pinned to a digest/);
		expect(() => loadTarget(targetFixture(block({ sandbox: "best-effort", image: TAG }))))
			.toThrow(/mutable tags cannot identify comparable evidence/);
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
		expect(() => loadTarget(targetFixture(
			block({ sandbox: "required", image: PINNED }).replace(`    platform: ${PLATFORM}\n`, ""),
		))).toThrow(/platform/);
		expect(() => loadTarget(targetFixture(
			block({ sandbox: "required", image: PINNED }).replace(PLATFORM, "--privileged"),
		))).toThrow(/platform/);
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
			detect: () => availableStatus(),
		});
		const fingerprint = containerSandboxFingerprint(policy(), RUNTIME_IDENTITY);
		expect(result.sandboxFingerprint).toBe(fingerprint);
		expect(result.sandboxBackend).toBe("none");
		expect(result.sandboxWarnings).toEqual([]);
		expect(effectiveTargetSandbox({ hasDeclaredTools: false, executionPolicy: result }))
			.toBe(fingerprint);
		expect(effectiveTargetSandbox({
			hasDeclaredTools: true,
			executionPolicy: result,
			targetTools: { sandboxFingerprint: fingerprint },
		})).toBe(fingerprint);
		expect(() => effectiveTargetSandbox({
			hasDeclaredTools: true,
			targetTools: { sandboxFingerprint: `container:docker@${TAG}` },
		})).toThrow();
		expect(targetFilesystemConfinement({
			workspaceMode: "isolated",
			toolNames: ["bash"],
			sandbox: fingerprint,
		})).toBe("workspace-confined-v1");
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
			const detected = detectContainerRuntime("docker", { environment: { PATH: fake.binDir }, force: true });
			const result = fixture({
				sandbox: "required",
				detect: () => detected,
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
			expect(args.join("\0")).not.toContain("must-not-leak");
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
		}
	});

	it("keeps the probed absolute client and Docker context after ambient process changes", async () => {
		const bound = fakeDocker();
		const switched = fakeDocker();
		const originalPath = process.env.PATH;
		const originalContext = process.env.DOCKER_CONTEXT;
		process.env.PATH = bound.binDir;
		process.env.DOCKER_CONTEXT = "bound-context";
		try {
			const result = fixture({ sandbox: "required" });
			process.env.PATH = switched.binDir;
			process.env.DOCKER_CONTEXT = "attacker-switched-context";
			const bash = result.customTools.find((tool) => tool.name === "bash");
			if (!bash) throw new Error("bash tool was not registered");
			await bash.execute("bound-runtime", { command: "echo hi" }, undefined, undefined, undefined as never);
			expect(loggedArgv(bound.logPath)[0]).toBe("run");
			expect(() => readFileSync(switched.logPath, "utf8")).toThrow();
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
			if (originalContext === undefined) delete process.env.DOCKER_CONTEXT;
			else process.env.DOCKER_CONTEXT = originalContext;
		}
	});

	it("fails closed when the probed Docker client bytes change before execution", async () => {
		const fake = fakeDocker();
		const originalPath = process.env.PATH;
		process.env.PATH = fake.binDir;
		try {
			const result = fixture({ sandbox: "required" });
			const binary = join(fake.binDir, "docker");
			writeFileSync(binary, `${readFileSync(binary, "utf8")}\n# replaced after probe\n`);
			chmodSync(binary, 0o755);
			const bash = result.customTools.find((tool) => tool.name === "bash");
			if (!bash) throw new Error("bash tool was not registered");
			await expect(
				bash.execute("changed-runtime", { command: "echo must-not-run" }, undefined, undefined, undefined as never),
			).rejects.toThrow(/container runtime changed after resolution/);
			if (existsSync(fake.logPath)) expect(loggedArgv(fake.logPath)).not.toContain("run");
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
		}
	});

	it("fails closed when the bound context starts addressing a different daemon", async () => {
		const infoFile = join(scratchRoot("daemon-identity"), "info.json");
		const info = (daemonId: string) => ({
			ID: daemonId,
			KernelVersion: RUNTIME_IDENTITY.kernelVersion,
			Driver: RUNTIME_IDENTITY.driver,
			CgroupDriver: RUNTIME_IDENTITY.cgroupDriver,
			CgroupVersion: RUNTIME_IDENTITY.cgroupVersion,
			SecurityOptions: ["name=seccomp,profile=builtin"],
		});
		writeFileSync(infoFile, `${JSON.stringify(info(RUNTIME_IDENTITY.daemonId))}\n`);
		const fake = fakeDocker({ infoFile });
		const originalPath = process.env.PATH;
		process.env.PATH = fake.binDir;
		try {
			const result = fixture({ sandbox: "required" });
			writeFileSync(infoFile, `${JSON.stringify(info("different-daemon-id"))}\n`);
			const bash = result.customTools.find((tool) => tool.name === "bash");
			if (!bash) throw new Error("bash tool was not registered");
			await expect(
				bash.execute("changed-daemon", { command: "echo must-not-run" }, undefined, undefined, undefined as never),
			).rejects.toThrow(/expected daemon-test-id\/.+, got different-daemon-id\//);
			if (existsSync(fake.logPath)) expect(loggedArgv(fake.logPath)).not.toContain("run");
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
		}
	});

	it("does not spawn a container when abort arrives during cwd resolution", async () => {
		const fake = fakeDocker();
		const originalPath = process.env.PATH;
		process.env.PATH = fake.binDir;
		try {
			const result = fixture({
				sandbox: "required",
				detect: () => availableStatus(),
			});
			const bash = result.customTools.find((tool) => tool.name === "bash");
			if (!bash) throw new Error("bash tool was not registered");
			const controller = new AbortController();
			const running = bash.execute(
				"call-aborted",
				{ command: "echo must-not-run" },
				controller.signal,
				undefined,
				undefined as never,
			);
			queueMicrotask(() => controller.abort());
			await expect(running).rejects.toThrow(/aborted/);
			expect(() => readFileSync(fake.logPath, "utf8")).toThrow();
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
		}
	});
});

describe("declared tool setup inside the container", () => {
	it("runs setup in a private one-tool home before composing the final home", () => {
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
			const setupToolMount = flagValues(args, "-v").find((mount) => mount.endsWith(":/tools:rw"));
			expect(setupToolMount).toBeDefined();
			expect(setupToolMount).not.toBe(`${toolHomeRoot}:/tools:rw`);
			expect(setupToolMount).toMatch(/\.ahde-tool-prepare-[^/]+\/tool-home:\/tools:rw$/);
			expect(existsSync(join(toolHomeRoot, "lookup", "run"))).toBe(true);
			expect(args).toContain(`${workspaceDir}:/workspace:ro`);
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

	it("force-removes the exact daemon container after setup timeout", () => {
		const fake = fakeDocker({ hangRun: true });
		const originalPath = process.env.PATH;
		process.env.PATH = fake.binDir;
		const root = scratchRoot("setup-container-timeout");
		const workspaceDir = join(root, "workspace");
		const scratchDir = join(root, "scratch");
		const toolHomeRoot = join(root, "tool-home");
		mkdirSync(join(workspaceDir, "tools/lookup"), { recursive: true });
		mkdirSync(scratchDir, { recursive: true });
		writeFileSync(join(workspaceDir, "tools/lookup/run"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(workspaceDir, "tools/lookup/run"), 0o755);
		const tool = resolvedDirectoryTool(workspaceDir);
		tool.descriptor.setup = { argv: ["/bin/sh", "-c", "true"], timeoutMs: 50, network: "deny" };
		try {
			expect(() => prepareToolHome({
				workspaceDir,
				scratchDir,
				toolHomeRoot,
				policy: { environmentAllowlist: [], network: "deny", sandbox: "required", container: policy() },
				sandboxBackend: "container",
				tools: [tool],
			})).toThrow(/timed out/);
			const cleanupArgv = loggedArgv(fake.logPath);
			expect(cleanupArgv.slice(0, 2)).toEqual(["rm", "-f"]);
			expect(cleanupArgv[2]).toMatch(/^ahde-[0-9]+-[0-9a-f-]+$/);
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
	it("names the runtime, its version, and the pinned image", () => {
		const fake = fakeDocker({ version: "27.1" });
		expect(describeSandboxReadiness(
			{ sandbox: "required", container: policy() },
			{ environment: { PATH: fake.binDir } },
		)).toEqual({
			line: "sandbox: container (docker 27.1, server linux/amd64, target linux/amd64, image pinned)",
			failClosed: false,
		});

		resetContainerRuntimeDetection();
		expect(describeSandboxReadiness(
			{ sandbox: "best-effort", container: policy({ image: TAG }) },
			{ environment: { PATH: fake.binDir } },
		)).toMatchObject({ failClosed: true });
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

// A loaded machine can take a while to answer the version probe; the gate is
// deliberately more patient than a run's own detection so the integration lane
// is skipped for a real reason, never for a busy CPU.
const dockerStatus = detectContainerRuntime("docker", { force: true, timeoutMs: 60_000 });
const INTEGRATION_IMAGE = "busybox:latest";

function localImage(): string | null {
	if (!dockerStatus.available) return null;
	const inspect = spawnSync("docker", ["image", "inspect", INTEGRATION_IMAGE], { stdio: "ignore", timeout: 30_000 });
	if (inspect.status === 0) return INTEGRATION_IMAGE;
	const pull = spawnSync("docker", ["pull", "--quiet", INTEGRATION_IMAGE], { stdio: "ignore", timeout: 180_000 });
	return pull.status === 0 ? INTEGRATION_IMAGE : null;
}

const integrationImage = localImage();
/** The pinned `name@sha256:…` form, which is the only image `sandbox: required` accepts. */
function pinnedIntegrationImage(): string | null {
	if (!integrationImage) return null;
	const inspect = spawnSync(
		"docker",
		["image", "inspect", integrationImage, "--format", "{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}"],
		{ encoding: "utf8", timeout: 30_000 },
	);
	const reference = (inspect.stdout ?? "").trim();
	return inspect.status === 0 && isPinnedContainerImage(reference) ? reference : null;
}
const integrationPinnedImage = pinnedIntegrationImage();
const integrationPlatform = dockerStatus.available
	? `${dockerStatus.identity.os}/${dockerStatus.identity.arch}`
	: null;
const integrationRuntimeBinding = dockerStatus.available
	? resolveExecutionBackend({
		policy: { sandbox: "required" as const, container: policy() },
		osBackend: () => "sandbox-exec" as const,
		detect: () => dockerStatus,
	}).containerRuntime
	: undefined;
const skipReason = dockerStatus.available
	? (integrationPinnedImage && integrationPlatform
		? ""
		: ` — SKIPPED: docker ${dockerStatus.identity.version} is up but no pinned image/platform was resolved`)
	: ` — SKIPPED: ${dockerStatus.reason}`;
if (skipReason) console.warn(`[container-backend integration]${skipReason}`);
if (process.env.AHDE_REQUIRE_DOCKER_TESTS === "1" && skipReason) {
	throw new Error(`Docker integration is required in this environment${skipReason}`);
}

describe.skipIf(!integrationPinnedImage || !integrationPlatform || !integrationRuntimeBinding)(`container backend integration (real docker)${skipReason}`, () => {
	it("runs the declared argv inside the container, sees only container paths, and inherits no host environment", () => {
		process.env[HOST_SECRET] = "must-not-leak";
		const root = scratchRoot("integration");
		const workspaceDir = join(root, "workspace");
		const scratchDir = join(root, "scratch");
		mkdirSync(workspaceDir, { recursive: true });
		mkdirSync(join(scratchDir, "home"), { recursive: true });
		writeFileSync(join(workspaceDir, "hello.txt"), "workspace-bytes\n");

		const invocation = dockerBackend.invocation({
			policy: policy({
				image: integrationPinnedImage as string,
				platform: integrationPlatform as string,
				memoryMb: 256,
				pidsLimit: 64,
			}),
			mounts: { workspaceDir, scratchDir },
			network: "deny",
			environment: { HOME: join(scratchDir, "home"), LANG: "C", ALLOWED_VALUE: "visible" },
			cwd: workspaceDir,
			argv: [
				"/bin/sh",
				"-c",
				`printf '%s|%s|%s|%s' "$PWD" "$(cat hello.txt | tr -d '\\n')" "$ALLOWED_VALUE" "\${${HOST_SECRET}-unset}"`,
			],
			runtimeBinding: integrationRuntimeBinding,
		});
		invocation.assertReady?.();
		const result = spawnSync(invocation.executable, invocation.args, {
			encoding: "utf8",
			env: invocation.spawnEnvironment,
			timeout: 120_000,
		});
		invocation.dispose?.();
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
				policy: policy({ image: integrationPinnedImage as string, platform: integrationPlatform as string }),
				mounts: { workspaceDir, scratchDir },
				network,
				environment: {},
				cwd: workspaceDir,
				argv: ["/bin/sh", "-c", command],
				runtimeBinding: integrationRuntimeBinding,
			});
			invocation.assertReady?.();
			const result = spawnSync(invocation.executable, invocation.args, {
				encoding: "utf8",
				env: invocation.spawnEnvironment,
				timeout: 120_000,
			});
			invocation.dispose?.();
			return result;
		};
		// `--network none` gives the container no interface but loopback: the
		// runtime enforces the policy, not a profile string the Target could
		// argue with.
		const denied = run("deny", "[ -e /sys/class/net/eth0 ] && echo attached || echo no-interface");
		expect(denied.status).toBe(0);
		expect(denied.stdout.trim()).toBe("no-interface");

		const allowed = run("allow", "[ -e /sys/class/net/eth0 ] && echo attached || echo no-interface");
		expect(allowed.status).toBe(0);
		expect(allowed.stdout.trim()).toBe("attached");

		const wrote = run("deny", "printf container-wrote > /workspace/out.txt && echo ok");
		expect(wrote.status).toBe(0);
		expect(readFileSync(join(workspaceDir, "out.txt"), "utf8")).toBe("container-wrote");

		// The root filesystem is read-only; only /tmp and the mounts are writable.
		const readOnly = run("deny", "touch /etc/ahde-probe 2>/dev/null && echo writable || echo read-only");
		expect(readOnly.stdout.trim()).toBe("read-only");
		const tmp = run("deny", "printf x > /tmp/probe && echo tmpfs-writable");
		expect(tmp.stdout.trim()).toBe("tmpfs-writable");
	});

	// `sandbox: required` accepts only a pinned digest, so this one case needs
	// the image's RepoDigest; a locally built image has none.
	it.skipIf(!integrationPinnedImage || !integrationPlatform)("runs the Target's built-in bash inside a real container, end to end", async () => {
		process.env[HOST_SECRET] = "must-not-leak";
		const root = scratchRoot("integration-bash");
		const workspaceDir = join(root, "workspace");
		const scratchDir = join(root, "scratch");
		mkdirSync(workspaceDir, { recursive: true });
		mkdirSync(scratchDir, { recursive: true });
		writeFileSync(join(workspaceDir, "note.txt"), "graded-bytes\n");

		const built = buildExecutionPolicy({
			workspaceDir,
			scratchDir,
			policy: {
				tools: ["bash"],
				environmentAllowlist: ["ALLOWED_VALUE"],
				network: "deny",
				sandbox: "required",
				container: policy({
					image: integrationPinnedImage as string,
					platform: integrationPlatform as string,
					memoryMb: 256,
					pidsLimit: 64,
				}),
			},
			environment: {
				PATH: "/usr/bin:/bin",
				LANG: "C",
				HOME: join(scratchDir, "home"),
				TMPDIR: join(scratchDir, "tmp"),
			},
			sourceEnvironment: { ALLOWED_VALUE: "visible", [HOST_SECRET]: "must-not-leak" },
		});
		if (!dockerStatus.available) throw new Error("real Docker probe returned no exact runtime identity");
		expect(built.sandboxFingerprint).toBe(containerSandboxFingerprint(
			policy({
				image: integrationPinnedImage as string,
				platform: integrationPlatform as string,
				memoryMb: 256,
				pidsLimit: 64,
			}),
			dockerStatus.identity,
		));

		const bash = built.customTools.find((tool) => tool.name === "bash");
		if (!bash) throw new Error("bash tool was not registered");
		const result = await bash.execute(
			"integration-bash",
			{ command: `printf '%s|%s|%s|%s' "$PWD" "$(cat note.txt | tr -d '\\n')" "$ALLOWED_VALUE" "\${${HOST_SECRET}-unset}"` },
			undefined,
			undefined,
			undefined as never,
		);
		const text = result.content.filter((part) => part.type === "text").map((part) => ("text" in part ? part.text : "")).join("");
		expect(text).toContain("/workspace|graded-bytes|[REDACTED]|unset");
	});
});
