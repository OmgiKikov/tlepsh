/**
 * Container containment for the Target's built-in `bash`, its declared tools,
 * and their `setup` step.
 *
 * `sandbox-exec` and `bwrap` are process-level sandboxes on the operator's own
 * host: the process still sees the host's kernel, its `/usr`, its network
 * stack, and whatever the profile forgot to deny. For a bank platform that is
 * not enough. This backend runs the same declared argv inside a container with
 * only the workspace, the scratch directory and (when multi-file tools exist)
 * the prepared tool home mounted, an environment built from nothing, and the
 * declared network policy enforced by the container runtime rather than by a
 * profile string.
 *
 * Docker is implemented. Gondolin (Earendil's Apache-2.0 micro-VM) gets the
 * same `ContainerBackend` interface and a stub that fails closed — nothing is
 * vendored here, so a build that claims Gondolin must first ship it.
 *
 * Two rules hold for every invocation this module builds:
 *
 *  1. Every path the model can see is a container path. A host path never
 *     enters the container's argv, its cwd, or its environment.
 *  2. The container environment starts empty. `PATH`, `HOME`, `TMPDIR`,
 *     `LANG` and `TERM` are set to container-owned values, and only the
 *     Target's declared allowlist names are copied through a private,
 *     invocation-scoped env-file. Values never enter the Docker CLI argv and
 *     the host's environment is never inherited.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export type ContainerRuntimeName = "docker" | "gondolin";

/**
 * The resolved `execution.container` block. Structurally identical to the
 * manifest schema, restated here so the backend does not depend on the
 * manifest module (and so tests can build one by hand).
 */
export interface ContainerPolicy {
	runtime: ContainerRuntimeName;
	image: string;
	/** Exact OCI target selected by the runtime; prevents host-native multi-arch drift. */
	platform: string;
	memoryMb?: number;
	cpus?: number;
	pidsLimit?: number;
	readOnlyRootfs: boolean;
}

/** Container-side mount points. The model never learns any other spelling. */
export const CONTAINER_WORKSPACE = "/workspace";
export const CONTAINER_SCRATCH = "/scratch";
export const CONTAINER_TOOL_HOME = "/tools";
/** The case's world, mounted only for a run whose case declares one. */
export const CONTAINER_WORLD = "/world";
export const CONTAINER_TMP = "/tmp";

/**
 * The container's PATH. Deliberately not the host's: `/opt/homebrew/bin` and
 * friends are host paths, and leaking one into the container's environment
 * would break rule 1 for no benefit — nothing there exists inside the image.
 */
export const CONTAINER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** Absolute prefixes that already name something inside the image. */
const CONTAINER_ROOTS = [
	CONTAINER_WORKSPACE,
	CONTAINER_SCRATCH,
	CONTAINER_TOOL_HOME,
	CONTAINER_WORLD,
	CONTAINER_TMP,
	"/bin",
	"/sbin",
	"/lib",
	"/lib64",
	"/usr",
	"/etc",
	"/opt",
	"/srv",
	"/var",
	"/run",
	"/home",
	"/root",
];

/** `name[:tag]@sha256:<64 hex>` — the only reproducible way to name an image. */
const PINNED_IMAGE = /@sha256:[0-9a-f]{64}$/;

/**
 * A conservative image reference: no whitespace, no shell metacharacters, no
 * leading dash (which `docker run` would read as a flag).
 */
export const CONTAINER_IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;

/** Docker/OCI platform: `os/arch` with an optional variant, never a CLI flag. */
export const CONTAINER_PLATFORM_REFERENCE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?$/;

/** True when the image is pinned to a content digest and therefore reproducible. */
export function isPinnedContainerImage(image: string): boolean {
	return PINNED_IMAGE.test(image);
}

/** `sha256:<64 hex>` for a pinned reference, otherwise null. */
export function containerImageDigest(image: string): string | null {
	const match = PINNED_IMAGE.exec(image);
	return match ? match[0].slice(1) : null;
}

/**
 * The provenance `sandbox` value for a run confined by this backend.
 *
 * The readable prefix keeps the image digest. The configuration hash binds
 * the explicit OCI platform, resource limits, rootfs mode, non-root user and
 * exact runtime server identity; changing any execution input starts a new
 * comparability class. Mutable references are refused rather than assigned a
 * false stable identity.
 */
export interface ContainerRuntimeIdentity {
	version: string;
	os: string;
	arch: string;
	/** Exact daemon + host-kernel execution context, never just the CLI version. */
	daemonId: string;
	kernelVersion: string;
	driver: string;
	cgroupDriver: string;
	cgroupVersion: string;
	securityOptionsHash: string;
	/** Hash of the exact Docker context/socket/config environment used by probe and run. */
	contextHash: string;
}

/**
 * Host-owned execution capability produced by the same successful probe that
 * minted container provenance. Every later CLI call uses this absolute client
 * and this frozen daemon-selection environment; ambient process changes are
 * deliberately irrelevant.
 */
export interface ContainerRuntimeBinding {
	runtime: ContainerRuntimeName;
	executable: string;
	spawnEnvironment: Readonly<NodeJS.ProcessEnv>;
	identity: Readonly<ContainerRuntimeIdentity>;
	probeTimeoutMs: number;
}

export function containerSandboxFingerprint(
	policy: ContainerPolicy,
	runtime: ContainerRuntimeIdentity,
): string {
	const digest = containerImageDigest(policy.image);
	if (!digest) {
		throw new Error(
			`execution.container.image must be pinned to a digest (name@sha256:…); mutable tags cannot identify comparable evidence; got ${policy.image}`,
		);
	}
	const configurationHash = createHash("sha256")
		.update(JSON.stringify({
			runtime,
			platform: policy.platform,
			memoryMb: policy.memoryMb ?? null,
			cpus: policy.cpus ?? null,
			pidsLimit: policy.pidsLimit ?? null,
			readOnlyRootfs: policy.readOnlyRootfs,
			user: defaultUser(),
		}))
		.digest("hex");
	return `container:${policy.runtime}@${digest}:config:${configurationHash}`;
}

/** True for any fingerprint produced by a container backend. */
export function isContainerSandboxFingerprint(value: string): boolean {
	return value.startsWith("container:");
}

// ---------- runtime detection ----------

export interface ContainerRuntimeStatus {
	runtime: ContainerRuntimeName;
	available: boolean;
	/** Server version reported by the runtime, when it answered. */
	version?: string;
	/** Server OS and architecture; both affect container execution semantics. */
	os?: string;
	arch?: string;
	daemonId?: string;
	kernelVersion?: string;
	driver?: string;
	cgroupDriver?: string;
	cgroupVersion?: string;
	securityOptionsHash?: string;
	contextHash?: string;
	/** Exact reason the runtime is unusable. Present iff `available` is false. */
	reason?: string;
}

export interface DetectContainerRuntimeOptions {
	/** Environment the runtime binary is looked up in. Defaults to `process.env`. */
	environment?: NodeJS.ProcessEnv;
	/** Bound on the version probe. Detection must never hang a run. */
	timeoutMs?: number;
	/** Bypass the per-process memo. Tests only. */
	force?: boolean;
}

const DETECTION_TIMEOUT_MS = 5_000;
const detectionCache = new Map<string, ContainerRuntimeStatus>();
const runtimeBindings = new WeakMap<ContainerRuntimeStatus, ContainerRuntimeBinding>();

/** Tests point PATH at a fake runtime; the memo must not outlive that fixture. */
export function resetContainerRuntimeDetection(): void {
	detectionCache.clear();
}

function executableOnPath(name: string, pathValue: string): string | undefined {
	const candidates = isAbsolute(name)
		? [name]
		: pathValue.split(delimiter).filter(Boolean).map((entry) => join(entry, name));
	for (const candidate of candidates) {
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {}
	}
	return undefined;
}

function firstLine(value: string | null | undefined): string {
	return (value ?? "").split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "";
}

interface RuntimeClientIdentity {
	path: string;
	sha256: string;
	size: number;
	mode: number;
}

function runtimeClientIdentity(binary: string): RuntimeClientIdentity {
	const path = realpathSync(binary);
	const stat = statSync(path);
	if (!stat.isFile()) throw new Error(`container runtime executable is not a regular file: ${path}`);
	return {
		path,
		sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
		size: stat.size,
		mode: stat.mode & 0o111,
	};
}

function detectionCacheKey(runtime: ContainerRuntimeName, environment: NodeJS.ProcessEnv): string {
	return createHash("sha256")
		.update(JSON.stringify({ runtime, environment: runtimeCliEnvironment(environment) }))
		.digest("hex");
}

function runtimeContextHash(client: RuntimeClientIdentity, environment: NodeJS.ProcessEnv): string {
	return createHash("sha256")
		.update(JSON.stringify({ client, environment: runtimeCliEnvironment(environment) }))
		.digest("hex");
}

function probeDocker(binary: string, timeoutMs: number, hostEnvironment: NodeJS.ProcessEnv): ContainerRuntimeStatus {
	let clientBefore: RuntimeClientIdentity;
	try {
		clientBefore = runtimeClientIdentity(binary);
	} catch (error) {
		return { runtime: "docker", available: false, reason: `docker executable identity is unavailable: ${(error as Error).message}` };
	}
	// One `docker version` call is the cheapest probe that proves the *daemon*
	// answers: `docker --version` only proves a client
	// binary exists, which is exactly the failure a bank profile must not
	// mistake for containment.
	const probe = spawnSync(
		clientBefore.path,
		["version", "--format", "{{.Server.Version}}|{{.Server.Os}}|{{.Server.Arch}}"],
		{
			env: runtimeCliEnvironment(hostEnvironment),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: timeoutMs,
			windowsHide: true,
		},
	);
	if (probe.error) {
		const code = (probe.error as NodeJS.ErrnoException).code;
		return {
			runtime: "docker",
			available: false,
			reason: code === "ETIMEDOUT"
				? `docker version probe timed out after ${timeoutMs}ms`
				: probe.error.message,
		};
	}
	const identity = firstLine(probe.stdout).split("|");
	const [version, os, arch] = identity;
	if (probe.status !== 0 || !version || !os || !arch || identity.length !== 3) {
		const detail = firstLine(probe.stderr) || firstLine(probe.stdout) || `exit ${probe.status}`;
		return { runtime: "docker", available: false, reason: `docker daemon is not reachable: ${detail}` };
	}
	const info = spawnSync(clientBefore.path, ["info", "--format", "{{json .}}"], {
		env: runtimeCliEnvironment(hostEnvironment),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: timeoutMs,
		windowsHide: true,
	});
	if (info.error || info.status !== 0) {
		const detail = firstLine(info.stderr) || firstLine(info.stdout) || info.error?.message || `exit ${info.status}`;
		return { runtime: "docker", available: false, reason: `docker daemon identity is unavailable: ${detail}` };
	}
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(firstLine(info.stdout)) as Record<string, unknown>;
	} catch {
		return { runtime: "docker", available: false, reason: "docker daemon identity was not valid JSON" };
	}
	const text = (key: string): string => typeof parsed[key] === "string" ? (parsed[key] as string).trim() : "";
	const daemonId = text("ID");
	const kernelVersion = text("KernelVersion");
	const driver = text("Driver");
	const cgroupDriver = text("CgroupDriver");
	const cgroupVersion = text("CgroupVersion");
	const securityOptions = Array.isArray(parsed.SecurityOptions)
		? parsed.SecurityOptions.filter((value): value is string => typeof value === "string").sort()
		: [];
	if (!daemonId || !kernelVersion || !driver || !cgroupDriver || !cgroupVersion) {
		return { runtime: "docker", available: false, reason: "docker daemon identity is incomplete" };
	}
	let clientAfter: RuntimeClientIdentity;
	try {
		clientAfter = runtimeClientIdentity(clientBefore.path);
	} catch (error) {
		return { runtime: "docker", available: false, reason: `docker executable identity is unavailable: ${(error as Error).message}` };
	}
	if (JSON.stringify(clientBefore) !== JSON.stringify(clientAfter)) {
		return { runtime: "docker", available: false, reason: "docker executable changed during identity probe" };
	}
	const status: ContainerRuntimeStatus = {
		runtime: "docker",
		available: true,
		version,
		os,
		arch,
		daemonId,
		kernelVersion,
		driver,
		cgroupDriver,
		cgroupVersion,
		securityOptionsHash: createHash("sha256").update(JSON.stringify(securityOptions)).digest("hex"),
		contextHash: runtimeContextHash(clientBefore, hostEnvironment),
	};
	runtimeBindings.set(status, Object.freeze({
		runtime: "docker",
		executable: clientBefore.path,
		spawnEnvironment: Object.freeze({ ...runtimeCliEnvironment(hostEnvironment) }),
		identity: Object.freeze({
			version,
			os,
			arch,
			daemonId,
			kernelVersion,
			driver,
			cgroupDriver,
			cgroupVersion,
			securityOptionsHash: status.securityOptionsHash as string,
			contextHash: status.contextHash as string,
		}),
		probeTimeoutMs: timeoutMs,
	}));
	return status;
}

/**
 * Probe a container runtime once per process. A run that spawns hundreds of
 * subprocesses must not spawn hundreds of `docker version` calls, and the
 * answer cannot change under a running eval without invalidating the evidence
 * anyway.
 */
export function detectContainerRuntime(
	runtime: ContainerRuntimeName,
	options: DetectContainerRuntimeOptions = {},
): ContainerRuntimeStatus {
	const environment = options.environment ?? process.env;
	// Cache the decision for the exact runtime CLI environment, even when the
	// binary disappears after the first probe. A run must not silently switch
	// containment identity halfway through; `force` is the explicit re-probe.
	const key = `${runtime}\0${detectionCacheKey(runtime, environment)}`;
	if (!options.force) {
		const cached = detectionCache.get(key);
		if (cached) return cached;
	}
	const pathValue = environment.PATH ?? "";
	const binary = runtime === "docker" ? executableOnPath("docker", pathValue) : undefined;
	const status = runtime === "gondolin"
		? gondolinBackend.unavailable()
		: (() => {
			if (!binary) {
				return { runtime: "docker" as const, available: false, reason: "docker executable not found on PATH" };
			}
			return probeDocker(binary, options.timeoutMs ?? DETECTION_TIMEOUT_MS, environment);
		})();
	detectionCache.set(key, status);
	return status;
}

// ---------- invocation ----------

export interface ContainerMountPlan {
	/** Host workspace, mounted at `/workspace`. */
	workspaceDir: string;
	/** `ro` for read-only declared tools; `rw` for the built-in shell and workspace-write tools. */
	workspaceMode?: "ro" | "rw";
	/** Host scratch, mounted read-write at `/scratch`. */
	scratchDir: string;
	/** Prepared multi-file tool home, mounted at `/tools`. Omitted when no directory tool exists. */
	toolHomeRoot?: string;
	/**
	 * `ro` for every ordinary tool call; `rw` only while a declared `setup`
	 * step populates the home it is about to be locked out of.
	 */
	toolHomeMode?: "ro" | "rw";
	/** The case's world directory, mounted at `/world`. Omitted when the case has none. */
	worldDir?: string;
	/** `rw` for a `workspace-write` tool that may change the world; `ro` otherwise. */
	worldMode?: "ro" | "rw";
}

export interface ContainerInvocationRequest {
	policy: ContainerPolicy;
	mounts: ContainerMountPlan;
	network: "deny" | "allow";
	/**
	 * The scrubbed host-side environment. Path values under a mount are
	 * rewritten to container paths; everything else is copied verbatim.
	 */
	environment: NodeJS.ProcessEnv;
	/** Host path under a mount, or an absolute container path. */
	cwd: string;
	/** argv[0] is a host path under a mount, an absolute container path, or a bare command. */
	argv: readonly string[];
	/** Host environment the runtime CLI itself is spawned with. Defaults to `process.env`. */
	hostEnvironment?: NodeJS.ProcessEnv;
	/** Exact client/daemon capability returned by the policy's successful probe. */
	runtimeBinding?: ContainerRuntimeBinding;
	/** Host-authorized wall-clock lifetime, used to recover stale crash orphans. */
	lifecycleTimeoutMs?: number;
	/** Stable injection seam for tests. Production calls receive a fresh unguessable name. */
	containerName?: string;
}

export interface ContainerInvocation {
	executable: string;
	args: string[];
	/**
	 * Environment for the *runtime CLI process on the host* — never the
	 * container's. `docker` needs its own PATH and its context/socket
	 * variables; the container's environment travels in `-e` flags inside
	 * `args`.
	 */
	spawnEnvironment: NodeJS.ProcessEnv;
	/** Re-probe the bound daemon immediately before spawning the runtime client. */
	assertReady?: () => void;
	/** Force-remove the named container after timeout, abort, or output overflow. */
	terminate?: () => void;
	/** Remove host-side invocation material after any normal or abnormal exit. */
	dispose?: () => void;
}

export interface ContainerBackend {
	readonly runtime: ContainerRuntimeName;
	/** Why this runtime cannot be used, as a status object. */
	unavailable(): ContainerRuntimeStatus;
	/** Build the exact argv for one confined invocation. */
	invocation(request: ContainerInvocationRequest): ContainerInvocation;
}

/** Host variables the runtime CLI needs to find its own daemon. Never forwarded into the container. */
const RUNTIME_CLI_ENVIRONMENT = [
	"DOCKER_API_VERSION",
	"DOCKER_CONTENT_TRUST",
	"DOCKER_CONTENT_TRUST_SERVER",
	"DOCKER_HOST",
	"DOCKER_CONTEXT",
	"DOCKER_CONFIG",
	"DOCKER_CERT_PATH",
	"DOCKER_CUSTOM_HEADERS",
	"DOCKER_DEFAULT_PLATFORM",
	"DOCKER_TLS",
	"DOCKER_TLS_VERIFY",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"SSL_CERT_DIR",
	"SSL_CERT_FILE",
	"XDG_RUNTIME_DIR",
	"XDG_CONFIG_HOME",
];

/** Names the container backend owns; a declared allowlist can never redefine them. */
const CONTAINER_FIXED_ENVIRONMENT = new Set(["PATH", "HOME", "TMPDIR", "LANG", "TERM"]);

function mountTable(mounts: ContainerMountPlan): { host: string; container: string }[] {
	const table = [
		{ host: mounts.workspaceDir, container: CONTAINER_WORKSPACE },
		{ host: mounts.scratchDir, container: CONTAINER_SCRATCH },
	];
	if (mounts.toolHomeRoot) table.push({ host: mounts.toolHomeRoot, container: CONTAINER_TOOL_HOME });
	if (mounts.worldDir) table.push({ host: mounts.worldDir, container: CONTAINER_WORLD });
	// Longest host prefix first: a tool home nested inside scratch must resolve
	// to /tools, not to /scratch/<…>.
	return table.sort((a, b) => b.host.length - a.host.length);
}

function underPrefix(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

/** Translate one host path to its container spelling, or null when it is not mounted. */
function translate(path: string, table: readonly { host: string; container: string }[]): string | null {
	for (const entry of table) {
		if (underPrefix(path, entry.host)) {
			const rest = path.slice(entry.host.length);
			return rest ? `${entry.container}${rest}` : entry.container;
		}
	}
	return null;
}

/**
 * A path the container will see. Host paths under a mount are rewritten;
 * absolute paths that already name something in the image pass through; an
 * absolute host path that is not mounted is refused rather than leaked.
 */
function containerPath(
	path: string,
	table: readonly { host: string; container: string }[],
	label: string,
): string {
	const mapped = translate(path, table);
	if (mapped) return mapped;
	if (!isAbsolute(path)) return path;
	if (CONTAINER_ROOTS.some((root) => underPrefix(path, root))) return path;
	throw new Error(`container backend refuses a host ${label} outside the mounted roots: ${path}`);
}

/** Environment values are translated only when they are mounted host paths. */
function containerValue(value: string, table: readonly { host: string; container: string }[]): string {
	return translate(value, table) ?? value;
}

function defaultUser(): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	const gid = typeof process.getgid === "function" ? process.getgid() : 0;
	// Never root inside the container. When the harness itself runs as root the
	// only safe choice is `nobody`; the bind mounts must then already be
	// world-writable, which is the operator's call, not a silent escalation.
	if (uid === 0) return "65534:65534";
	return `${uid}:${gid}`;
}

function containerEnvironment(
	request: ContainerInvocationRequest,
	table: readonly { host: string; container: string }[],
): [string, string][] {
	// HOME and TMPDIR are host paths under scratch today. Only their translated
	// spelling may enter the container; an untranslatable one is replaced, never
	// passed through, because a host path in HOME is exactly the leak rule 1
	// forbids.
	const home = (request.environment.HOME && translate(request.environment.HOME, table))
		?? `${CONTAINER_SCRATCH}/home`;
	const temporary = (request.environment.TMPDIR && translate(request.environment.TMPDIR, table))
		?? CONTAINER_TMP;
	const fixed: [string, string][] = [
		["PATH", CONTAINER_PATH],
		["HOME", home],
		["TMPDIR", temporary],
		["LANG", request.environment.LANG ?? "C.UTF-8"],
		// A confined process has no terminal. Saying so beats letting a host
		// TERM leak in and change how a tool renders its output.
		["TERM", "dumb"],
	];
	const declared: [string, string][] = [];
	for (const [name, value] of Object.entries(request.environment)) {
		if (value === undefined || CONTAINER_FIXED_ENVIRONMENT.has(name)) continue;
		declared.push([name, containerValue(value, table)]);
	}
	declared.sort(([a], [b]) => a.localeCompare(b));
	return [...fixed, ...declared];
}

function runtimeCliEnvironment(hostEnvironment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		PATH: hostEnvironment.PATH ?? "/usr/local/bin:/usr/bin:/bin",
	};
	// The docker CLI reads ~/.docker/{config.json,contexts} to find the daemon.
	if (hostEnvironment.HOME) environment.HOME = hostEnvironment.HOME;
	for (const name of RUNTIME_CLI_ENVIRONMENT) {
		const value = hostEnvironment[name];
		if (value !== undefined) environment[name] = value;
	}
	return environment;
}

const AHDE_MANAGED_LABEL = "com.ahde.managed";
const AHDE_OWNER_LABEL = "com.ahde.owner";
const AHDE_SESSION_LABEL = "com.ahde.session";
const AHDE_EXPIRES_LABEL = "com.ahde.expires-at-ms";
const CONTAINER_RECOVERY_PREFIX = "ahde-container-lifecycle-";
const CONTAINER_RECOVERY_RECORD = "recovery.json";
const CONTAINER_RECOVERY_SCHEMA = 1;
const LATE_CREATE_GRACE_MS = 10_000;
const RECOVERY_NOT_FOUND_RETENTION_MS = 60 * 60 * 1_000;

interface DockerLifecycleRecord {
	schemaVersion: 1;
	containerName: string;
	sessionId: string;
	ownerId: string;
	createdAtMs: number;
	expiresAtMs: number | null;
	identity: ContainerRuntimeIdentity;
}

function runtimeIdentity(status: ContainerRuntimeStatus): ContainerRuntimeIdentity | null {
	const values = [
		status.version,
		status.os,
		status.arch,
		status.daemonId,
		status.kernelVersion,
		status.driver,
		status.cgroupDriver,
		status.cgroupVersion,
		status.securityOptionsHash,
		status.contextHash,
	];
	if (!status.available || !values.every((value) => typeof value === "string" && value.length > 0)) return null;
	return {
		version: status.version as string,
		os: status.os as string,
		arch: status.arch as string,
		daemonId: status.daemonId as string,
		kernelVersion: status.kernelVersion as string,
		driver: status.driver as string,
		cgroupDriver: status.cgroupDriver as string,
		cgroupVersion: status.cgroupVersion as string,
		securityOptionsHash: status.securityOptionsHash as string,
		contextHash: status.contextHash as string,
	};
}

function sameRuntimeIdentity(left: ContainerRuntimeIdentity, right: ContainerRuntimeIdentity): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Re-probe through the already-bound absolute client and environment. This is
 * intentionally uncached: provenance from daemon A must never authorize a run
 * after the same socket/context starts addressing daemon B.
 */
export function assertContainerRuntimeBinding(binding: ContainerRuntimeBinding): void {
	if (binding.runtime !== "docker") throw new Error(`${binding.runtime} runtime binding is not executable in this build`);
	let current: ContainerRuntimeStatus;
	try {
		current = probeDocker(binding.executable, binding.probeTimeoutMs, { ...binding.spawnEnvironment });
	} catch (error) {
		throw new Error(`container runtime changed after resolution: ${(error as Error).message}`, { cause: error });
	}
	const identity = runtimeIdentity(current);
	if (!identity || !sameRuntimeIdentity(binding.identity, identity)) {
		const actual = identity
			? `${identity.daemonId}/${identity.contextHash}`
			: current.reason ?? "runtime identity unavailable";
		throw new Error(
			`container runtime changed after resolution; expected ${binding.identity.daemonId}/${binding.identity.contextHash}, got ${actual}`,
		);
	}
}

function ownerId(binding: ContainerRuntimeBinding): string {
	return createHash("sha256")
		.update(JSON.stringify({
			uid: typeof process.getuid === "function" ? process.getuid() : null,
			contextHash: binding.identity.contextHash,
		}))
		.digest("hex");
}

function validContainerName(value: unknown): value is string {
	return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
}

function isNotFound(detail: string): boolean {
	return /no such (?:container|object)|not found/i.test(detail);
}

function commandDetail(result: ReturnType<typeof spawnSync>): string {
	return firstLine(result.stderr?.toString()) || firstLine(result.stdout?.toString()) || result.error?.message || `exit ${result.status}`;
}

function readContainerId(path: string): string | null {
	if (!existsSync(path)) return null;
	const value = readFileSync(path, "utf8").trim();
	if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("container runtime wrote an invalid cidfile");
	return value;
}

function dockerArguments(
	request: ContainerInvocationRequest,
	environmentFile: string,
	cidFile: string,
	record: DockerLifecycleRecord,
): string[] {
	const { policy, mounts } = request;
	if (!CONTAINER_IMAGE_REFERENCE.test(policy.image)) {
		throw new Error(`container backend refuses an unsafe image reference: ${policy.image}`);
	}
	if (!isPinnedContainerImage(policy.image)) {
		throw new Error(
			`container backend refuses a mutable image; use name@sha256:<digest>: ${policy.image}`,
		);
	}
	if (!CONTAINER_PLATFORM_REFERENCE.test(policy.platform)) {
		throw new Error(`container backend refuses an unsafe platform: ${policy.platform}`);
	}
	if (request.argv.length === 0) throw new Error("container backend requires a command");
	const table = mountTable(mounts);
	const containerName = request.containerName ?? `ahde-${process.pid}-${randomUUID()}`;
	if (!validContainerName(containerName)) {
		throw new Error(`container backend refuses an unsafe container name: ${containerName}`);
	}
	const args = [
		"run",
		"--rm",
		"--name",
		containerName,
		"--cidfile",
		cidFile,
		"--label",
		`${AHDE_MANAGED_LABEL}=true`,
		"--label",
		`${AHDE_OWNER_LABEL}=${record.ownerId}`,
		"--label",
		`${AHDE_SESSION_LABEL}=${record.sessionId}`,
		"--label",
		`${AHDE_EXPIRES_LABEL}=${record.expiresAtMs ?? "unbounded"}`,
		"--platform",
		policy.platform,
	];

	// Network is the runtime's, not a profile's: `none` gives the container no
	// interface at all. `--network host` is never emitted — it would hand the
	// Target the operator's whole network namespace.
	args.push("--network", request.network === "deny" ? "none" : "bridge");
	args.push("--user", defaultUser());
	args.push("--cap-drop", "ALL");
	args.push("--security-opt", "no-new-privileges");
	if (policy.readOnlyRootfs) {
		args.push("--read-only");
		args.push("--tmpfs", `${CONTAINER_TMP}:rw,nosuid,nodev,exec,mode=1777`);
	}
	if (policy.memoryMb !== undefined) args.push("--memory", `${policy.memoryMb}m`);
	if (policy.cpus !== undefined) args.push("--cpus", String(policy.cpus));
	if (policy.pidsLimit !== undefined) args.push("--pids-limit", String(policy.pidsLimit));

	args.push("-v", `${mounts.workspaceDir}:${CONTAINER_WORKSPACE}:${mounts.workspaceMode ?? "rw"}`);
	args.push("-v", `${mounts.scratchDir}:${CONTAINER_SCRATCH}:rw`);
	if (mounts.toolHomeRoot) {
		args.push("-v", `${mounts.toolHomeRoot}:${CONTAINER_TOOL_HOME}:${mounts.toolHomeMode ?? "ro"}`);
	}
	if (mounts.worldDir) args.push("-v", `${mounts.worldDir}:${CONTAINER_WORLD}:${mounts.worldMode ?? "ro"}`);

	args.push("--env-file", environmentFile);
	args.push("-w", containerPath(request.cwd, table, "cwd"));

	// `--entrypoint` is not decoration: an image that declares its own
	// ENTRYPOINT would otherwise prepend it to the declared argv, so the bytes
	// that ran would not be the bytes the descriptor names.
	const [command, ...rest] = request.argv;
	args.push("--entrypoint", containerPath(command as string, table, "command"));
	args.push(policy.image);
	for (const argument of rest) args.push(containerPath(argument, table, "argument"));
	return args;
}

function privateRecoveryRecord(directory: string): DockerLifecycleRecord | null {
	try {
		const directoryStat = lstatSync(directory);
		if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0) return null;
		if (typeof process.getuid === "function" && directoryStat.uid !== process.getuid()) return null;
		const path = join(directory, CONTAINER_RECOVERY_RECORD);
		const recordStat = lstatSync(path);
		if (!recordStat.isFile() || recordStat.isSymbolicLink() || (recordStat.mode & 0o077) !== 0) return null;
		if (typeof process.getuid === "function" && recordStat.uid !== process.getuid()) return null;
		if (recordStat.size > 32 * 1024) return null;
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DockerLifecycleRecord>;
		if (
			parsed.schemaVersion !== CONTAINER_RECOVERY_SCHEMA ||
			!validContainerName(parsed.containerName) ||
			typeof parsed.sessionId !== "string" || !/^[0-9a-f-]{36}$/.test(parsed.sessionId) ||
			typeof parsed.ownerId !== "string" || !/^[0-9a-f]{64}$/.test(parsed.ownerId) ||
			typeof parsed.createdAtMs !== "number" || !Number.isSafeInteger(parsed.createdAtMs) ||
			(parsed.expiresAtMs !== null && (typeof parsed.expiresAtMs !== "number" || !Number.isSafeInteger(parsed.expiresAtMs))) ||
			!parsed.identity || runtimeIdentity({ runtime: "docker", available: true, ...parsed.identity }) === null
		) return null;
		return parsed as DockerLifecycleRecord;
	} catch {
		return null;
	}
}

function inspectManagedContainer(
	binding: ContainerRuntimeBinding,
	identifier: string,
	record: DockerLifecycleRecord,
): "owned" | "absent" {
	const inspected = spawnSync(binding.executable, ["inspect", "--format", "{{json .Config.Labels}}", identifier], {
		env: { ...binding.spawnEnvironment },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 5_000,
		windowsHide: true,
	});
	if (inspected.status !== 0 || inspected.error) {
		const detail = commandDetail(inspected);
		if (isNotFound(detail)) return "absent";
		throw new Error(`failed to inspect stale container ${record.containerName}: ${detail}`);
	}
	let labels: Record<string, unknown>;
	try {
		labels = JSON.parse(firstLine(inspected.stdout)) as Record<string, unknown>;
	} catch (error) {
		throw new Error(`container ${record.containerName} returned invalid ownership labels`, { cause: error });
	}
	if (
		labels[AHDE_MANAGED_LABEL] !== "true" ||
		labels[AHDE_OWNER_LABEL] !== record.ownerId ||
		labels[AHDE_SESSION_LABEL] !== record.sessionId ||
		labels[AHDE_EXPIRES_LABEL] !== String(record.expiresAtMs)
	) {
		throw new Error(`refusing to recover container ${record.containerName}: AHDE ownership labels do not match`);
	}
	return "owned";
}

function removeExactContainer(
	binding: ContainerRuntimeBinding,
	identifier: string,
	containerName: string,
): "removed" | "absent" {
	const removed = spawnSync(binding.executable, ["rm", "-f", identifier], {
		env: { ...binding.spawnEnvironment },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 5_000,
		windowsHide: true,
	});
	if (removed.status === 0 && !removed.error) return "removed";
	const detail = commandDetail(removed);
	if (isNotFound(detail)) return "absent";
	throw new Error(`failed to remove container ${containerName}: ${detail}`);
}

/**
 * Recover only expired containers with a private, same-user journal and exact
 * matching daemon/context + labels. Unbounded shell invocations deliberately
 * have no expiry and are skipped: without a host deadline they cannot safely
 * be declared stale, so broad age-based GC would risk deleting live work.
 */
function recoverStaleDockerContainers(binding: ContainerRuntimeBinding): void {
	let entries: string[];
	try {
		entries = readdirSync(tmpdir()).filter((entry) => entry.startsWith(CONTAINER_RECOVERY_PREFIX));
	} catch {
		return;
	}
	const now = Date.now();
	for (const entry of entries) {
		const directory = join(tmpdir(), entry);
		const record = privateRecoveryRecord(directory);
		if (!record || record.expiresAtMs === null || record.expiresAtMs > now) continue;
		if (!sameRuntimeIdentity(record.identity, binding.identity) || record.ownerId !== ownerId(binding)) continue;
		const cidFile = join(directory, "container.cid");
		const identifier = readContainerId(cidFile) ?? record.containerName;
		const ownership = inspectManagedContainer(binding, identifier, record);
		if (ownership === "owned") {
			const outcome = removeExactContainer(binding, identifier, record.containerName);
			if (outcome === "removed") rmSync(directory, { recursive: true, force: true });
			continue;
		}
		// A killed client can close before the daemon publishes the container.
		// Retain the exact journal for a full hour after expiry so a later AHDE
		// invocation can collect that late creation. Only then discard inert state.
		if (now - record.expiresAtMs >= RECOVERY_NOT_FOUND_RETENTION_MS) {
			rmSync(directory, { recursive: true, force: true });
		}
	}
}

export const dockerBackend: ContainerBackend = {
	runtime: "docker",
	unavailable(): ContainerRuntimeStatus {
		return { runtime: "docker", available: false, reason: "docker runtime not detected" };
	},
	invocation(request: ContainerInvocationRequest): ContainerInvocation {
		if (request.runtimeBinding && request.runtimeBinding.runtime !== "docker") {
			throw new Error(`docker backend received a ${request.runtimeBinding.runtime} runtime binding`);
		}
		if (
			request.lifecycleTimeoutMs !== undefined &&
			(!Number.isSafeInteger(request.lifecycleTimeoutMs) || request.lifecycleTimeoutMs < 1 || request.lifecycleTimeoutMs > 2_147_483_647)
		) {
			throw new Error("container lifecycle timeout must be a positive, bounded integer in milliseconds");
		}
		const hostEnvironment = request.hostEnvironment ?? process.env;
		const binary = request.runtimeBinding?.executable
			?? executableOnPath("docker", hostEnvironment.PATH ?? "")
			?? "docker";
		const spawnEnvironment = request.runtimeBinding
			? { ...request.runtimeBinding.spawnEnvironment }
			: runtimeCliEnvironment(hostEnvironment);
		const containerName = request.containerName ?? `ahde-${process.pid}-${randomUUID()}`;
		const resolvedRequest = { ...request, containerName };
		const sessionId = randomUUID();
		// Docker needs the env-file and cidfile on the host, but Target code must
		// never see either through /scratch. The recovery record makes an expired
		// daemon-owned orphan collectible after this client process crashes.
		const lifecycleRoot = mkdtempSync(join(tmpdir(), CONTAINER_RECOVERY_PREFIX));
		chmodSync(lifecycleRoot, 0o700);
		const environmentFile = join(lifecycleRoot, "environment");
		const cidFile = join(lifecycleRoot, "container.cid");
		const now = Date.now();
		const identity = request.runtimeBinding?.identity ?? {
			version: "unbound",
			os: "unbound",
			arch: "unbound",
			daemonId: "unbound",
			kernelVersion: "unbound",
			driver: "unbound",
			cgroupDriver: "unbound",
			cgroupVersion: "unbound",
			securityOptionsHash: "0".repeat(64),
			contextHash: "0".repeat(64),
		};
		const record: DockerLifecycleRecord = {
			schemaVersion: CONTAINER_RECOVERY_SCHEMA,
			containerName,
			sessionId,
			ownerId: request.runtimeBinding
				? ownerId(request.runtimeBinding)
				: createHash("sha256").update(`unbound:${typeof process.getuid === "function" ? process.getuid() : "unknown"}`).digest("hex"),
			createdAtMs: now,
			expiresAtMs: request.lifecycleTimeoutMs === undefined
				? null
				: now + request.lifecycleTimeoutMs + LATE_CREATE_GRACE_MS,
			identity: { ...identity },
		};
		let terminated = false;
		let cleanupConfirmed = false;
		const removeEnvironmentFile = (): void => {
			rmSync(environmentFile, { force: true });
		};
		const dispose = (): void => {
			// Preserve an uncertain timeout/abort journal. A later exact runtime
			// binding can recover it after its host-owned expiry; ordinary exits and
			// confirmed force-removals leave no lifecycle material behind.
			if (!terminated || cleanupConfirmed) rmSync(lifecycleRoot, { recursive: true, force: true });
		};
		let args: string[];
		try {
			const lines = containerEnvironment(request, mountTable(request.mounts)).map(([name, value]) => {
				if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
					throw new Error(`container backend refuses an unsafe environment name: ${name}`);
				}
				if (/[\0\r\n]/.test(value)) {
					throw new Error(`container backend refuses a multiline or NUL value for ${name}`);
				}
				return `${name}=${value}`;
			});
			writeFileSync(environmentFile, `${lines.join("\n")}\n`, { mode: 0o600, flag: "wx" });
			writeFileSync(
				join(lifecycleRoot, CONTAINER_RECOVERY_RECORD),
				`${JSON.stringify(record)}\n`,
				{ mode: 0o600, flag: "wx" },
			);
			args = dockerArguments(resolvedRequest, environmentFile, cidFile, record);
		} catch (error) {
			rmSync(lifecycleRoot, { recursive: true, force: true });
			throw error;
		}
		return {
			executable: binary,
			args,
			spawnEnvironment,
			assertReady: () => {
				try {
					if (!request.runtimeBinding) {
						throw new Error("container invocation has no runtime binding from the provenance probe");
					}
					assertContainerRuntimeBinding(request.runtimeBinding);
					recoverStaleDockerContainers(request.runtimeBinding);
				} catch (error) {
					// This invocation never reached the runtime, so it cannot own a
					// daemon orphan. Remove its private env/recovery material immediately.
					rmSync(lifecycleRoot, { recursive: true, force: true });
					throw error;
				}
			},
			dispose,
			terminate: () => {
				// Killing the attached Docker CLI does not guarantee that the daemon
				// stops the container. Once the client is confirmed closed, address the
				// daemon by the exact host-minted name; a normal `--rm` exit makes this
				// a harmless "not found". Cleanup is bounded and never inherits Target
				// env.
				terminated = true;
				removeEnvironmentFile();
				if (!request.runtimeBinding) {
					throw new Error("container cleanup has no runtime binding from the provenance probe");
				}
				// Never address a different daemon during cleanup. If the original
				// context is temporarily unavailable, retain the private journal for
				// recovery when that exact identity returns.
				assertContainerRuntimeBinding(request.runtimeBinding);
				let failure = "container cleanup failed";
				let hardFailure = false;
				for (let attempt = 1; attempt <= 8; attempt += 1) {
					const identifier = readContainerId(cidFile) ?? containerName;
					try {
						const outcome = removeExactContainer(request.runtimeBinding, identifier, containerName);
						if (outcome === "removed") {
							cleanupConfirmed = true;
							dispose();
							return;
						}
						failure = "container not found yet";
					} catch (error) {
						failure = (error as Error).message.replace(/^failed to remove container [^:]+:\s*/, "");
						hardFailure = !isNotFound(failure);
					}
					if (attempt < 8) {
						const retryGate = new Int32Array(new SharedArrayBuffer(4));
						Atomics.wait(retryGate, 0, 0, Math.min(500, attempt * 100));
					}
				}
				// Absence is not proof after a killed client: the daemon may publish a
				// late create. Keep the exact journal; a later invocation rechecks it.
				if (hardFailure) {
					throw new Error(`failed to remove container ${containerName} after 8 attempts: ${failure}`);
				}
			},
		};
	},
};

export const GONDOLIN_UNAVAILABLE = "gondolin runtime not available in this build";

/**
 * Gondolin is Earendil's Apache-2.0 micro-VM and the next backend behind this
 * interface. Nothing is vendored: the stub fails closed so a manifest that
 * asks for it under `sandbox: required` stops the run instead of quietly
 * falling back to a weaker containment.
 */
export const gondolinBackend: ContainerBackend = {
	runtime: "gondolin",
	unavailable(): ContainerRuntimeStatus {
		return { runtime: "gondolin", available: false, reason: GONDOLIN_UNAVAILABLE };
	},
	invocation(): ContainerInvocation {
		throw new Error(GONDOLIN_UNAVAILABLE);
	},
};

export function containerBackendFor(runtime: ContainerRuntimeName): ContainerBackend {
	return runtime === "gondolin" ? gondolinBackend : dockerBackend;
}

// ---------- the required / best-effort / off matrix ----------

export type ContainerSandboxMode = "container" | "fallback";

export interface ContainerSandboxDecision {
	/** `container` runs inside the runtime; `fallback` hands the run back to the OS sandbox. */
	mode: ContainerSandboxMode;
	status: ContainerRuntimeStatus;
	/** Non-fatal findings the run records, such as a best-effort fallback. */
	warnings: string[];
	/**
	 * The provenance `sandbox` value for this decision. Present only for
	 * `container`; a fallback deliberately reports the OS backend that
	 * actually confined the run, so it can never masquerade as container
	 * evidence.
	 */
	fingerprint?: string;
	/** Exact executable/environment/daemon capability backing this decision. */
	runtimeBinding?: ContainerRuntimeBinding;
}

export interface ResolveContainerSandboxOptions {
	policy: ContainerPolicy;
	sandbox: "required" | "best-effort" | "off";
	/** Detection seam. Tests inject a fake runtime instead of touching a daemon. */
	detect?: (runtime: ContainerRuntimeName) => ContainerRuntimeStatus;
	detectOptions?: DetectContainerRuntimeOptions;
}

/**
 * Decide whether one run is confined by the container runtime.
 *
 * | `execution.sandbox` | runtime usable | image | outcome |
 * |---|---|---|---|
 * | `required`    | yes | pinned digest | container; `container:<runtime>@sha256:…` |
 * | `required`    | yes | tag           | refused (the manifest already refuses it at load) |
 * | `required`    | no  | any           | refused, fail closed, with the runtime's exact reason |
 * | `best-effort` | yes | pinned digest | container; `container:<runtime>@sha256:…` |
 * | `best-effort` | yes | tag           | refused: a mutable image cannot identify evidence |
 * | `best-effort` | no  | any           | fallback to the OS sandbox + warning; the OS backend's own value |
 * | `off`         | —   | —             | never reaches here (the manifest refuses the block) |
 */
export function resolveContainerSandbox(options: ResolveContainerSandboxOptions): ContainerSandboxDecision {
	const { policy, sandbox } = options;
	if (sandbox === "off") {
		throw new Error("execution.container requires sandbox: required or best-effort; sandbox: off declares no containment");
	}
	if (!isPinnedContainerImage(policy.image)) {
		throw new Error(
			`execution.container.image must be pinned to a digest (name@sha256:…); mutable tags cannot identify comparable evidence; got ${policy.image}`,
		);
	}
	const detect = options.detect
		?? ((runtime: ContainerRuntimeName) => detectContainerRuntime(runtime, options.detectOptions ?? {}));
	const status = detect(policy.runtime);
	const identityValues = [
		status.version,
		status.os,
		status.arch,
		status.daemonId,
		status.kernelVersion,
		status.driver,
		status.cgroupDriver,
		status.cgroupVersion,
		status.securityOptionsHash,
		status.contextHash,
	];
	const identity = status.available && identityValues.every(
		(value) => typeof value === "string" && value.trim().length > 0 && value.length <= 256,
	)
		? {
			version: status.version as string,
			os: status.os as string,
			arch: status.arch as string,
			daemonId: status.daemonId as string,
			kernelVersion: status.kernelVersion as string,
			driver: status.driver as string,
			cgroupDriver: status.cgroupDriver as string,
			cgroupVersion: status.cgroupVersion as string,
			securityOptionsHash: status.securityOptionsHash as string,
			contextHash: status.contextHash as string,
		}
		: null;
	if (!status.available || !identity) {
		const reason = !status.available
			? status.reason ?? `${policy.runtime} runtime is unavailable`
			: `${policy.runtime} did not report an exact daemon, context, kernel, cgroup, and server identity`;
		if (sandbox === "required") {
			throw new Error(
				`execution.container declares ${policy.runtime} but no usable runtime is present; sandbox: required fails closed: ${reason}`,
			);
		}
		return {
			mode: "fallback",
			status,
			warnings: [
				`container backend unavailable (${reason}); falling back to the host OS sandbox — this run is NOT container evidence`,
			],
		};
	}
	const runtimeBinding = runtimeBindings.get(status);
	return {
		mode: "container",
		status,
		warnings: [],
		fingerprint: containerSandboxFingerprint(policy, identity),
		...(runtimeBinding ? { runtimeBinding } : {}),
	};
}

export interface ExecutionBackendChoice<T extends string> {
	/** `"container"` when the runtime confines the run; otherwise whatever the OS seam returned. */
	backend: T | "container";
	/** The provenance `sandbox` value for this run. */
	sandboxFingerprint: string;
	warnings: string[];
	status?: ContainerRuntimeStatus;
	/** Present for a production container decision made by the built-in probe. */
	containerRuntime?: ContainerRuntimeBinding;
}

/**
 * One decision point shared by the built-in `bash`, the declared-tool broker
 * and the `setup` step: they must never disagree about what confined a run.
 *
 * `osBackend` is the caller's existing OS-sandbox detection — it is only
 * consulted when no container was asked for, or when `best-effort` falls back
 * to it. Passing it in keeps this module free of the platform probes.
 */
export function resolveExecutionBackend<T extends string>(options: {
	policy: { sandbox: "required" | "best-effort" | "off"; container?: ContainerPolicy };
	osBackend: () => T;
	detect?: (runtime: ContainerRuntimeName) => ContainerRuntimeStatus;
	detectOptions?: DetectContainerRuntimeOptions;
}): ExecutionBackendChoice<T> {
	if (!options.policy.container) {
		const backend = options.osBackend();
		return { backend, sandboxFingerprint: backend, warnings: [] };
	}
	const decision = resolveContainerSandbox({
		policy: options.policy.container,
		sandbox: options.policy.sandbox,
		...(options.detect ? { detect: options.detect } : {}),
		...(options.detectOptions ? { detectOptions: options.detectOptions } : {}),
	});
	if (decision.mode === "container") {
		return {
			backend: "container",
			sandboxFingerprint: decision.fingerprint as string,
			warnings: decision.warnings,
			status: decision.status,
			...(decision.runtimeBinding ? { containerRuntime: decision.runtimeBinding } : {}),
		};
	}
	// best-effort fallback: the OS sandbox actually confined this run, so the
	// fingerprint says so. It is a different value from any container
	// fingerprint, which is the whole point — fallback evidence must never be
	// comparable with container evidence.
	const backend = options.osBackend();
	return { backend, sandboxFingerprint: backend, warnings: decision.warnings, status: decision.status };
}

// ---------- `ahde validate` readiness ----------

export interface SandboxReadiness {
	line: string;
	/** True when the declared policy cannot be honoured on this host. */
	failClosed: boolean;
}

/**
 * The one line `ahde validate` prints about containment. It states what would
 * actually confine a run on this host right now, never what the manifest
 * hopes for.
 */
export function describeSandboxReadiness(execution: {
	sandbox: "required" | "best-effort" | "off";
	container?: ContainerPolicy;
	tools?: readonly string[];
}, detectOptions: DetectContainerRuntimeOptions = {}): SandboxReadiness {
	if (!execution.container) {
		return { line: `sandbox: ${execution.sandbox} (host OS sandbox)`, failClosed: false };
	}
	let decision: ContainerSandboxDecision;
	try {
		decision = resolveContainerSandbox({ policy: execution.container, sandbox: execution.sandbox, detectOptions });
	} catch (error) {
		return { line: `sandbox: FAIL CLOSED — ${(error as Error).message}`, failClosed: true };
	}
	if (decision.mode === "fallback") {
		return {
			line: `sandbox: container requested, ${decision.warnings[0] ?? "unavailable"} (${execution.sandbox})`,
			failClosed: false,
		};
	}
	const version = decision.status.version ? ` ${decision.status.version}` : "";
	const server = decision.status.os && decision.status.arch
		? `, server ${decision.status.os}/${decision.status.arch}`
		: "";
	return {
		line:
			`sandbox: container (${execution.container.runtime}${version}${server}, ` +
			`target ${execution.container.platform}, image pinned)`,
		failClosed: false,
	};
}
