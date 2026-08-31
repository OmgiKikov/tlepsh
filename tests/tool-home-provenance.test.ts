import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashFile } from "../src/provenance.js";
import { detectTargetToolSandbox } from "../src/target/tool-broker.js";
import {
	prepareToolHome,
	preparedToolHomeHash,
	type PrepareToolHomeOptions,
} from "../src/target/tool-setup.js";

function fixture(): {
	root: string;
	options: (home: string, version: string) => PrepareToolHomeOptions;
} | null {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ahde-prepared-home-")));
	const workspaceDir = join(root, "workspace");
	const scratchDir = join(root, "scratch");
	const toolDir = join(workspaceDir, "tools", "lookup");
	mkdirSync(toolDir, { recursive: true, mode: 0o700 });
	mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
	const runPath = join(toolDir, "run");
	writeFileSync(runPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	chmodSync(runPath, 0o700);
	let backend: ReturnType<typeof detectTargetToolSandbox>;
	try {
		backend = detectTargetToolSandbox(workspaceDir, scratchDir);
	} catch {
		rmSync(root, { recursive: true, force: true });
		return null;
	}
	const content = readFileSync(runPath);
	const fileHash = hashFile(content.toString("base64"));
	const tool = {
		descriptor: {
			schemaVersion: 1 as const,
			name: "lookup",
			description: "fixture",
			parameters: { type: "object" as const, properties: {}, additionalProperties: false as const },
			command: { argv: ["tools/lookup/run"] },
			timeoutMs: 5_000,
			maxOutputBytes: 8_192,
			output: "text" as const,
			permissions: {
				environment: ["PREP_VERSION"],
				network: "deny" as const,
				filesystem: "read-only" as const,
			},
			lockfiles: [],
			setup: {
				argv: ["/bin/sh", "-c", "printf '%s' \"$PREP_VERSION\" > prepared.txt"],
				timeoutMs: 5_000,
				network: "deny" as const,
			},
		},
		descriptorPath: "tools/lookup/tool.yaml",
		executablePath: "tools/lookup/run",
		executableHash: fileHash,
		digest: fileHash,
		layout: "directory" as const,
		directoryPath: "tools/lookup",
		files: [{ path: "run", sha256: fileHash, executable: true, bytes: content.byteLength }],
	} as PrepareToolHomeOptions["tools"][number];
	return {
		root,
		options: (toolHomeRoot, version) => ({
			workspaceDir,
			scratchDir,
			toolHomeRoot,
			tools: [tool],
			policy: {
				environmentAllowlist: ["PREP_VERSION"],
				network: "deny",
				sandbox: "required",
			},
			sandboxBackend: backend,
			sourceEnvironment: {
				PATH: process.env.PATH ?? "/usr/bin:/bin",
				LANG: "C.UTF-8",
				PREP_VERSION: version,
			},
		}),
	};
}

describe("prepared tool-home provenance", () => {
	it("binds setup-produced bytes and executable modes, while excluding only the host marker", () => {
		const value = fixture();
		if (!value) return;
		try {
			const one = prepareToolHome(value.options(join(value.root, "home-one"), "one"));
			const two = prepareToolHome(value.options(join(value.root, "home-two"), "two"));
			expect(one.sha256).not.toBe(two.sha256);
			expect(readFileSync(join(one.root, "lookup", "prepared.txt"), "utf8")).toBe("one");

			const beforeMarkerEdit = preparedToolHomeHash(one.root);
			writeFileSync(join(one.root, ".ahde-tool-home.json"), "host marker bytes do not enter the digest\n");
			expect(preparedToolHomeHash(one.root)).toBe(beforeMarkerEdit);

			chmodSync(join(one.root, "lookup", "prepared.txt"), 0o700);
			expect(preparedToolHomeHash(one.root)).not.toBe(beforeMarkerEdit);
		} finally {
			rmSync(value.root, { recursive: true, force: true });
		}
	});

	it("verifies cached bytes against the marker and reprepares after marker or output tamper", () => {
		const value = fixture();
		if (!value) return;
		try {
			const home = join(value.root, "home");
			const first = prepareToolHome(value.options(home, "stable"));
			expect(first.prepared).toBe(true);
			expect(prepareToolHome(value.options(home, "stable")).prepared).toBe(false);

			const markerPath = join(home, ".ahde-tool-home.json");
			const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
			writeFileSync(markerPath, `${JSON.stringify({ ...marker, sha256: `sha256:${"0".repeat(64)}` })}\n`);
			const afterMarkerTamper = prepareToolHome(value.options(home, "stable"));
			expect(afterMarkerTamper.prepared).toBe(true);
			expect(afterMarkerTamper.sha256).toBe(first.sha256);

			writeFileSync(join(home, "lookup", "prepared.txt"), "tampered");
			const afterOutputTamper = prepareToolHome(value.options(home, "stable"));
			expect(afterOutputTamper.prepared).toBe(true);
			expect(afterOutputTamper.sha256).toBe(first.sha256);
			expect(readFileSync(join(home, "lookup", "prepared.txt"), "utf8")).toBe("stable");
		} finally {
			rmSync(value.root, { recursive: true, force: true });
		}
	});

	it("never persists or reports an allowlisted credential printed by setup", () => {
		const value = fixture();
		if (!value) return;
		const secret = "opaque-setup-value-with-no-token-shape";
		try {
			const home = join(value.root, "home-secret");
			const options = value.options(home, secret);
			const setup = options.tools[0]?.descriptor.setup;
			if (!setup) throw new Error("fixture setup is missing");
			setup.argv = [
				"/bin/sh",
				"-c",
				"printf '%s' \"$PREP_VERSION\"; printf '%s' \"$PREP_VERSION\" > prepared.txt",
			];
			const prepared = prepareToolHome(options);
			expect(prepared.setups[0]?.stdout).toBe("[REDACTED]");
			const marker = readFileSync(join(home, ".ahde-tool-home.json"), "utf8");
			expect(marker).not.toContain(secret);
			expect(JSON.parse(marker).setups[0]).toMatchObject({ stdout: "", stderr: "" });

			const cached = prepareToolHome(value.options(home, secret));
			expect(cached.prepared).toBe(false);
			expect(cached.setups[0]).toMatchObject({ stdout: "", stderr: "" });
		} finally {
			rmSync(value.root, { recursive: true, force: true });
		}
	});

	it("redacts an allowlisted credential from setup failure diagnostics", () => {
		const value = fixture();
		if (!value) return;
		const secret = "opaque-failing-setup-value";
		try {
			const options = value.options(join(value.root, "home-failure"), secret);
			const setup = options.tools[0]?.descriptor.setup;
			if (!setup) throw new Error("fixture setup is missing");
			setup.argv = ["/bin/sh", "-c", "printf '%s' \"$PREP_VERSION\" >&2; exit 7"];
			let failure: Error | null = null;
			try {
				prepareToolHome(options);
			} catch (error) {
				failure = error as Error;
			}
			expect(failure).not.toBeNull();
			expect(failure?.message).not.toContain(secret);
			expect(failure?.message).toContain("[REDACTED]");
		} finally {
			rmSync(value.root, { recursive: true, force: true });
		}
	});

	it("fails closed on symlinks and irregular files in the prepared tree", () => {
		const root = mkdtempSync(join(tmpdir(), "ahde-prepared-home-invalid-"));
		try {
			writeFileSync(join(root, "regular"), "x");
			symlinkSync("regular", join(root, "linked"));
			expect(() => preparedToolHomeHash(root)).toThrow(/symlink/);
			rmSync(join(root, "linked"));
			execFileSync("mkfifo", [join(root, "pipe")]);
			expect(() => preparedToolHomeHash(root)).toThrow(/non-regular/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
