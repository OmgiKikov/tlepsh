import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildExecutionPolicy,
	EXECUTION_POLICY_SESSION_OPTIONS,
	type ExecutionPolicy,
	type ExecutionPolicyResult,
} from "../src/execution-policy.js";

function fixture(policy: ExecutionPolicy, sourceEnvironment: NodeJS.ProcessEnv = {}) {
	const root = mkdtempSync(join(tmpdir(), "ahde-execution-policy-"));
	const workspaceDir = join(root, "workspace");
	const scratchDir = join(root, "scratch");
	const homeDir = join(scratchDir, "home");
	const tempDir = join(scratchDir, "tmp");
	mkdirSync(workspaceDir);
	mkdirSync(scratchDir);
	try {
		const result = buildExecutionPolicy({
			workspaceDir,
			scratchDir,
			policy,
			environment: {
				PATH: "/usr/bin:/bin:/usr/local/bin",
				LANG: "C",
				HOME: homeDir,
				TMPDIR: tempDir,
			},
			sourceEnvironment,
		});
		return { root, workspaceDir, scratchDir, homeDir, tempDir, result };
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
}

function tool(result: ExecutionPolicyResult, name: string) {
	const definition = result.customTools.find((candidate) => candidate.name === name);
	if (!definition) throw new Error(`Missing ${name} tool`);
	return definition;
}

async function execute(result: ExecutionPolicyResult, name: string, input: unknown) {
	return tool(result, name).execute("test-call", input, undefined, undefined, undefined as never);
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => ("text" in part ? part.text : ""))
		.join("\n");
}

describe("execution policy", () => {
	it("states the Pi session option that replaces built-in tools", () => {
		expect(EXECUTION_POLICY_SESSION_OPTIONS).toEqual({ noTools: "builtin" });
	});

	it("reports the OS backend as its own sandbox fingerprint when no container is declared", () => {
		const built = fixture({
			tools: ["read"],
			environmentAllowlist: [],
			network: "allow",
			sandbox: "off",
		});
		try {
			expect(built.result.sandboxBackend).toBe("none");
			expect(built.result.sandboxFingerprint).toBe("none");
			expect(built.result.sandboxFingerprint.startsWith("container:")).toBe(false);
			expect(built.result.sandboxWarnings).toEqual([]);
		} finally {
			rmSync(built.root, { recursive: true, force: true });
		}
	});

	it("scrubs ambient secrets and never returns explicitly allowlisted values to the model", async () => {
		const built = fixture(
			{
				tools: ["bash"],
				environmentAllowlist: ["ALLOWED_VALUE"],
				network: "allow",
				sandbox: "off",
			},
			{
				ALLOWED_VALUE: "visible",
				AMBIENT_SECRET: "must-not-leak",
				PI_SESSION_ID: "must-not-leak-either",
			},
		);
		try {
			const output = text(
				await execute(built.result, "bash", {
					command:
						`/usr/bin/printf '%s|%s|%s|%s' "$ALLOWED_VALUE" "\${AMBIENT_SECRET-unset}" "$HOME" "\${PI_SESSION_ID-unset}"`,
				}),
			);
			expect(output).toBe(`[REDACTED]|unset|${realpathSync(built.homeDir)}|unset`);
			expect(built.result.effectiveEnvironmentNames).toEqual([
				"ALLOWED_VALUE",
				"HOME",
				"LANG",
				"PATH",
				"TMPDIR",
			]);
		} finally {
			rmSync(built.root, { recursive: true, force: true });
		}
	});

	it("redacts a credential split across stream chunks and a trailing partial value", async () => {
		const secret = "opaque-split-secret";
		const built = fixture(
			{
				tools: ["bash"],
				environmentAllowlist: ["ALLOWED_VALUE"],
				network: "allow",
				sandbox: "off",
			},
			{ ALLOWED_VALUE: secret },
		);
		try {
			const split = text(await execute(built.result, "bash", {
				command: "/usr/bin/printf 'prefix:opaque-split-'; /bin/sleep 0.05; /usr/bin/printf 'secret'",
			}));
			expect(split).toBe("prefix:[REDACTED]");
			expect(split).not.toContain(secret);

			const partial = text(await execute(built.result, "bash", {
				command: "/usr/bin/printf 'prefix:opaque-split-'",
			}));
			expect(partial).toBe("prefix:[REDACTED]");
		} finally {
			rmSync(built.root, { recursive: true, force: true });
		}
	});

	it("allows workspace reads, edits, and safe nested creation", async () => {
		const built = fixture({
			tools: ["write", "edit", "read"],
			environmentAllowlist: [],
			network: "allow",
			sandbox: "off",
		});
		try {
			await execute(built.result, "write", { path: "nested/note.txt", content: "before\n" });
			await execute(built.result, "edit", {
				path: "nested/note.txt",
				edits: [{ oldText: "before", newText: "after" }],
			});
			const output = text(await execute(built.result, "read", { path: "nested/note.txt" }));
			expect(output).toBe("after\n");
			expect(readFileSync(join(built.workspaceDir, "nested/note.txt"), "utf8")).toBe("after\n");
		} finally {
			rmSync(built.root, { recursive: true, force: true });
		}
	});

	it("rejects read and write escapes through a workspace symlink", async () => {
		const built = fixture({
			tools: ["read", "write"],
			environmentAllowlist: [],
			network: "allow",
			sandbox: "off",
		});
		const siblingDir = join(built.root, "sibling");
		mkdirSync(siblingDir);
		writeFileSync(join(siblingDir, "secret.txt"), "secret");
		symlinkSync(siblingDir, join(built.workspaceDir, "escape"));
		try {
			await expect(execute(built.result, "read", { path: "escape/secret.txt" })).rejects.toThrow(
				/outside workspace/,
			);
			await expect(
				execute(built.result, "write", { path: "escape/new.txt", content: "escaped" }),
			).rejects.toThrow(/outside workspace/);
			expect(existsSync(join(siblingDir, "new.txt"))).toBe(false);
		} finally {
			rmSync(built.root, { recursive: true, force: true });
		}
	});

	it("blocks sibling-file reads and loopback network access when a sandbox backend is usable", async () => {
		let built: ReturnType<typeof fixture>;
		try {
			built = fixture({
				tools: ["bash"],
				environmentAllowlist: [],
				network: "deny",
				sandbox: "best-effort",
			});
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toMatch(/network=deny fails closed/);
			return;
		}
		const siblingSecret = join(built.root, "sibling-secret.txt");
		writeFileSync(siblingSecret, "sibling-secret");
		const server = createServer((_request, response) => response.end("reachable"));
		try {
			expect(built.result.sandboxBackend).not.toBe("none");

			await expect(
				execute(built.result, "bash", { command: `/bin/cat ${JSON.stringify(siblingSecret)}` }),
			).rejects.toThrow();

			const curl = ["/usr/bin/curl", "/usr/local/bin/curl"].find(existsSync);
			if (!curl) return;
			await new Promise<void>((resolveListen, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", resolveListen);
			});
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Expected TCP server address");
			await expect(
				execute(built.result, "bash", {
					command: `${JSON.stringify(curl)} --silent --fail --max-time 2 http://127.0.0.1:${address.port}`,
				}),
			).rejects.toThrow();
		} finally {
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
			rmSync(built.root, { recursive: true, force: true });
		}
	});
});
