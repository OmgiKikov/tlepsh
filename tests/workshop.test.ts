import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BuilderWorkshopEmptyError,
	BuilderWorkshopScopeError,
	openBuilderWorkshop,
	reattachBuilderWorkshop,
	type BuilderWorkshop,
} from "../src/application/tool-workshop.js";
import { inspectTargetAuthoringContext } from "../src/application/target-authoring-context.js";
import { CANDIDATE_SCOPE_POLICY } from "../src/application/candidate-experiment.js";
import { recordBuilderAuthoredProposal } from "../src/application/builder-authoring.js";
import {
	applyBuilderProposal,
	listBuilderProposalAdmissions,
	loadBuilderProposalRun,
} from "../src/application/builder-proposal.js";
import { validateCandidateProposal } from "../src/builders/adapters.js";
import { withDetachedWorktree } from "../src/git/experiment-worktree.js";
import { createAhdeWorkbench, type AhdeWorkbench } from "../src/workbench/workbench.js";
import type { WorkbenchConfirmation, WorkbenchHumanGate } from "../src/workbench/types.js";
import { createAhdeBuilderTools } from "../src/builder/extension.js";
import { loadTarget } from "../src/manifest.js";
import { baseFixtureFiles, cleanup, makeTargetFixture } from "./fixtures.js";

const created: string[] = [];

afterEach(() => {
	while (created.length > 0) cleanup(created.pop() as string);
});

const MANIFEST = `id: workshop-target
model:
  provider: test
  id: test-model
  api: openai-completions
  baseUrl: http://127.0.0.1:1/v1
  apiKeyEnv: TEST_MODEL_KEY
  thinkingLevel: "off"
  timeoutMs: 1000
execution:
  tools: [read]
  environmentAllowlist: []
  network: deny
  sandbox: best-effort
instructions:
  agentsMd: AGENTS.md
skills: []
tools: []
evalSuite:
  id: workshop-suite
  dataset: evals/development.jsonl
  graders: evals/graders.yaml
`;

/**
 * The permissive Target: it may read a credential and it may reach the network.
 * Everything the workshop refuses below, it refuses despite this manifest.
 */
const PERMISSIVE_MANIFEST = MANIFEST
	.replace("environmentAllowlist: []", "environmentAllowlist: [WORKSHOP_TARGET_SECRET]")
	.replace("network: deny", "network: allow");

function fixture(options: { manifest?: string; gitignore?: string } = {}): string {
	const dir = makeTargetFixture(baseFixtureFiles({
		"manifest.yaml": options.manifest ?? MANIFEST,
		".gitignore": options.gitignore ?? ".ahde/\nruns/\ndata/private/\n",
		"AGENTS.md": "# Workshop Target\n\nAnswer briefly.\n",
		".env": "OPERATOR_SECRET=do-not-read-me\n",
	}).filter((file) => file.path !== "skills/check-dbo/SKILL.md" && file.path !== "bin/check_dbo"));
	created.push(dir);
	mkdirSync(join(dir, "imports"), { recursive: true });
	writeFileSync(join(dir, "imports/tickets.jsonl"), "{\"input\":\"private\"}\n", "utf8");
	execFileSync("git", ["-C", dir, "add", "-A"]);
	execFileSync("git", [
		"-C", dir, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "--amend", "--no-edit", "-q",
	]);
	return dir;
}

function open(dir: string, overrides: Partial<Parameters<typeof openBuilderWorkshop>[0]> = {}): BuilderWorkshop {
	const target = loadTarget(dir);
	const context = inspectTargetAuthoringContext({
		repositoryDir: dir,
		expectedTarget: { id: target.manifest.id, gitSha: target.gitSha },
	});
	return openBuilderWorkshop({
		repositoryDir: dir,
		expectedTarget: { id: context.target.id, gitSha: context.target.gitSha },
		authoringContext: context.claim,
		binding: {
			basis: "improvement",
			approvedSpecId: "spec_workshop_fixture",
			source: {
				algorithmId: "exact-eval-signals-v1",
				evalRunId: "erun_workshop_fixture",
				diagnosisId: "diag_workshop_fixture",
				briefId: "brief-000000000000000000000000",
			},
		},
		...overrides,
	});
}

/** Every tracked and untracked file of a checkout, by path, mode, and bytes. */
function checkoutDigest(dir: string): string {
	const entries: string[] = [];
	const walk = (absolute: string, prefix: string): void => {
		for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (prefix === "" && entry.name === ".git") continue;
			const child = join(absolute, entry.name);
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			const info = lstatSync(child);
			if (info.isDirectory()) {
				walk(child, relativePath);
				continue;
			}
			entries.push(`${relativePath} ${(info.mode & 0o777).toString(8)} ${createHash("sha256").update(readFileSync(child)).digest("hex")}`);
		}
	};
	walk(dir, "");
	return entries.join("\n");
}

function worktreeCount(dir: string): number {
	return execFileSync("git", ["-C", dir, "worktree", "list"], { encoding: "utf8" }).trim().split("\n").length;
}

function sandboxUnavailable(error: unknown): boolean {
	return error instanceof Error && /No usable sandbox backend/.test(error.message);
}

const LOOKUP_DESCRIPTOR = `schemaVersion: 1
name: lookup
description: Return the prepared answer for a term.
parameters:
  type: object
  properties:
    term: { type: string, minLength: 1, maxLength: 100 }
  required: [term]
  additionalProperties: false
command:
  argv: [tools/lookup/run]
timeoutMs: 10000
maxOutputBytes: 8192
output: json
permissions:
  environment: []
  network: deny
  filesystem: read-only
setup:
  argv: [sh, -c, "cp lib.sh prepared.sh"]
  timeoutMs: 20000
  network: deny
`;

const NETWORK_DESCRIPTOR = LOOKUP_DESCRIPTOR
	.replace("setup:\n  argv: [sh, -c, \"cp lib.sh prepared.sh\"]\n  timeoutMs: 20000\n  network: deny\n",
		"setup:\n  argv: [sh, -c, \"cp lib.sh prepared.sh\"]\n  timeoutMs: 20000\n  network: allow\n");

const LOOKUP_RUN = `#!/bin/sh
IFS= read -r payload || exit 2
. "$AHDE_TOOL_HOME/prepared.sh"
printf '{"answer":"%s","payload":%s}\\n' "$ANSWER" "$payload"
`;

/** The multi-file tool a Builder writes in the workshop, setup step included. */
function writeLookupTool(workshop: BuilderWorkshop, answer = "authored"): void {
	workshop.write({ path: "tools/lookup/tool.yaml", content: LOOKUP_DESCRIPTOR });
	workshop.write({ path: "tools/lookup/run", content: LOOKUP_RUN });
	workshop.write({ path: "tools/lookup/lib.sh", content: `ANSWER=${answer}\n` });
}

describe("a workshop writes only inside its own worktree", () => {
	it("keeps the operator's checkout byte-identical and leaves no worktree behind", () => {
		const dir = fixture();
		const before = checkoutDigest(dir);
		const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
		const workshop = open(dir);
		try {
			expect(worktreeCount(dir)).toBe(2);
			expect(workshop.path).not.toContain(dir);
			workshop.write({ path: "AGENTS.md", content: "# Workshop Target\n\nAlways answer READY.\n" });
			writeLookupTool(workshop);
			workshop.write({ path: "skills/lookup-first/SKILL.md", content: "---\nname: lookup-first\ndescription: Use the lookup tool first.\n---\n\nCall lookup before answering.\n" });
			workshop.write({ path: "data/docs/policy.md", content: "Refunds close after 30 days.\n" });

			// Everything landed in the worktree.
			expect(readFileSync(join(workshop.path, "AGENTS.md"), "utf8")).toContain("READY");
			expect((lstatSync(join(workshop.path, "tools/lookup/run")).mode & 0o111) !== 0).toBe(true);
			expect((lstatSync(join(workshop.path, "tools/lookup/lib.sh")).mode & 0o111) === 0).toBe(true);
			// The host owns the declarations; the Builder never wrote the manifest.
			const manifest = readFileSync(join(workshop.path, "manifest.yaml"), "utf8");
			expect(manifest).toContain("tools/lookup/tool.yaml");
			expect(manifest).toContain("skills/lookup-first");
			expect(manifest).toContain("data/docs");

			// And nothing at all landed in the operator's checkout.
			expect(checkoutDigest(dir)).toBe(before);
			expect(execFileSync("git", ["-C", dir, "status", "--porcelain", "-uall"], { encoding: "utf8" })).toBe("");
			expect(execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(head);
		} finally {
			workshop.dispose();
		}
		expect(worktreeCount(dir)).toBe(1);
		expect(checkoutDigest(dir)).toBe(before);
	});

	it("reads what it will change, and lists a directory it has not seen", () => {
		const dir = fixture();
		const workshop = open(dir);
		try {
			expect(workshop.read("AGENTS.md").content).toBe("# Workshop Target\n\nAnswer briefly.\n");
			writeLookupTool(workshop);
			const listing = workshop.read("tools/lookup");
			expect(listing.kind).toBe("directory");
			expect(listing.entries?.map((entry) => entry.path)).toEqual([
				"tools/lookup/lib.sh",
				"tools/lookup/run",
				"tools/lookup/tool.yaml",
			]);
			// An exact replacement, not a rewrite of the whole file.
			const replaced = workshop.write({ path: "tools/lookup/lib.sh", oldText: "authored", newText: "replaced" });
			expect(replaced.action).toBe("updated");
			expect(workshop.read("tools/lookup/lib.sh").content).toBe("ANSWER=replaced\n");
			expect(() => workshop.write({ path: "AGENTS.md", oldText: "nowhere", newText: "x" }))
				.toThrow(/oldText does not occur in AGENTS\.md/);
			const removed = workshop.write({ path: "tools/lookup/lib.sh", remove: true });
			expect(removed.action).toBe("removed");
			expect(existsSync(join(workshop.path, "tools/lookup/lib.sh"))).toBe(false);
		} finally {
			workshop.dispose();
		}
	});
});

describe("a workshop refuses every path outside the Harness scope", () => {
	const outOfScope = [
		"manifest.yaml",
		"evals/development.jsonl",
		"evals/graders.yaml",
		".git/config",
		".env",
		".ahde/state.json",
		"imports/tickets.jsonl",
		"runs/erun_1/run.json",
		"../escape.txt",
		"tools/../manifest.yaml",
		"/etc/passwd",
		"skills",
		"bin",
	];

	it("names the exact offending path on read and on write", () => {
		const dir = fixture();
		const workshop = open(dir);
		try {
			for (const path of outOfScope) {
				expect(() => workshop.read(path), `read ${path}`).toThrow(BuilderWorkshopScopeError);
				expect(() => workshop.read(path), `read ${path}`).toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
				expect(() => workshop.write({ path, content: "x\n" }), `write ${path}`).toThrow(BuilderWorkshopScopeError);
				expect(() => workshop.write({ path, content: "x\n" }), `write ${path}`)
					.toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			}
			// The refusal is a refusal: nothing was created or rewritten on the way to it.
			expect(readFileSync(join(workshop.path, ".env"), "utf8")).toBe("OPERATOR_SECRET=do-not-read-me\n");
			expect(readFileSync(join(workshop.path, "evals/graders.yaml"), "utf8")).toBe("defaults: []\n");
		} finally {
			workshop.dispose();
		}
	});

	it("fails closed on a symlink that leaves the worktree", () => {
		const dir = fixture();
		const outside = mkdtempSync(join(tmpdir(), "ahde-workshop-outside-"));
		created.push(outside);
		writeFileSync(join(outside, "secret.txt"), "operator secret\n", "utf8");
		const workshop = open(dir);
		try {
			mkdirSync(join(workshop.path, "tools"), { recursive: true });
			symlinkSync(outside, join(workshop.path, "tools/escape"));
			expect(() => workshop.read("tools/escape/secret.txt")).toThrow(/tools\/escape\/secret\.txt.*symlink/s);
			expect(() => workshop.write({ path: "tools/escape/secret.txt", content: "rewritten\n" }))
				.toThrow(/tools\/escape\/secret\.txt.*symlink/s);
			expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("operator secret\n");
			// A symlink placed directly in the scope is refused as itself, too.
			symlinkSync(join(outside, "secret.txt"), join(workshop.path, "tools/link.tool.yaml"));
			expect(() => workshop.read("tools/link.tool.yaml")).toThrow(/tools\/link\.tool\.yaml.*symlink/s);
		} finally {
			workshop.dispose();
		}
	});

	it("refuses to compile a change Git would swallow or that sits outside the scope", () => {
		const dir = fixture();
		const workshop = open(dir);
		try {
			// Written inside the scope, but ignored by the Target's own .gitignore:
			// it can never reach a reviewed diff, so it can never be proposed.
			workshop.write({ path: "data/private/notes.md", content: "invisible\n" });
			expect(() => workshop.compile({ summary: "Ignored data" }))
				.toThrow(/data\/private\/notes\.md.*Git ignores/s);
			workshop.write({ path: "data/private/notes.md", remove: true });

			// A rogue file outside the scope stops the whole close and names itself.
			mkdirSync(join(workshop.path, "evals"), { recursive: true });
			writeFileSync(join(workshop.path, "evals/extra.jsonl"), "{}\n", "utf8");
			workshop.write({ path: "AGENTS.md", content: "# Workshop Target\n\nAnswer READY.\n" });
			expect(() => workshop.compile({ summary: "Out of scope" }))
				.toThrow(/workshop scope refuses evals\/extra\.jsonl/);
		} finally {
			workshop.dispose();
		}
	});

	it("refuses to close a workshop that changed nothing", () => {
		const dir = fixture();
		const workshop = open(dir);
		try {
			expect(workshop.changes()).toEqual([]);
			expect(() => workshop.compile({ summary: "Nothing happened" })).toThrow(BuilderWorkshopEmptyError);
			// Writing the same bytes back is still nothing.
			workshop.write({ path: "AGENTS.md", content: "# Workshop Target\n\nAnswer briefly.\n" });
			expect(() => workshop.compile({ summary: "Still nothing" })).toThrow(BuilderWorkshopEmptyError);
		} finally {
			workshop.dispose();
		}
	});
});

describe("the workshop shell", () => {
	it("runs argv in the OS sandbox, writes only inside the scope, and bounds its output", async () => {
		const dir = fixture();
		const workshop = open(dir);
		try {
			let hello;
			try {
				hello = await workshop.bash({ argv: ["sh", "-c", "printf 'made %s\\n' \"$(pwd | wc -c)\" >/dev/null; printf hello"] });
			} catch (error) {
				if (sandboxUnavailable(error)) return;
				throw error;
			}
			expect(hello.exitCode).toBe(0);
			expect(hello.stdout).toBe("hello");
			expect(["sandbox-exec", "bwrap"]).toContain(hello.sandbox);
			expect(hello.network).toBe("deny");

			// Writable inside the scope…
			const inside = await workshop.bash({ argv: ["sh", "-c", "mkdir -p tools/generated && printf 'ok\\n' > tools/generated/marker"] });
			expect(inside.exitCode).toBe(0);
			expect(readFileSync(join(workshop.path, "tools/generated/marker"), "utf8")).toBe("ok\n");

			// …and nowhere else. The sandbox refuses; the file never changes.
			const outside = await workshop.bash({ argv: ["sh", "-c", "printf 'x' > evals/graders.yaml"] });
			expect(outside.exitCode).not.toBe(0);
			expect(readFileSync(join(workshop.path, "evals/graders.yaml"), "utf8")).toBe("defaults: []\n");

			// Output is bounded, not streamed into the conversation.
			const loud = await workshop.bash({ argv: ["sh", "-c", "i=0; while [ $i -lt 4000 ]; do printf 'noisy line of output\\n'; i=$((i+1)); done"] });
			expect(loud.truncated).toBe(true);
			expect(Buffer.byteLength(loud.stdout, "utf8")).toBeLessThanOrEqual(8 * 1024);

			// And it is a command, not a shell string the host interpolates.
			await expect(workshop.bash({ argv: ["../../../bin/sh"] })).rejects.toThrow(/bare PATH command/);
			await expect(workshop.bash({ argv: ["sh", "-c", "true"], cwd: "evals" })).rejects.toThrow(/workshop scope refuses evals/);
		} finally {
			workshop.dispose();
		}
	}, 120_000);
});

describe("the authoring profile", () => {
	it("hands pre-review code no Target secret, whatever the manifest allows", async () => {
		const dir = fixture({ manifest: PERMISSIVE_MANIFEST });
		process.env.WORKSHOP_TARGET_SECRET = "target-secret-value";
		process.env.WORKSHOP_UNDECLARED_TOKEN = "undeclared-secret-value";
		const workshop = open(dir);
		try {
			let environment;
			try {
				environment = await workshop.bash({ argv: ["sh", "-c", "env"] });
			} catch (error) {
				if (sandboxUnavailable(error)) return;
				throw error;
			}
			expect(environment.exitCode).toBe(0);
			// The Target declares this one. The workshop still does not pass it.
			expect(environment.stdout).not.toContain("target-secret-value");
			expect(environment.stdout).not.toContain("WORKSHOP_TARGET_SECRET");
			expect(environment.stdout).not.toContain("undeclared-secret-value");
			// Exactly the fixed set, and nothing that could be a credential.
			expect(environment.environment).toEqual(["HOME", "LANG", "LC_ALL", "PATH", "TERM", "TMPDIR"]);
			const names = environment.stdout.split("\n")
				.map((line) => line.slice(0, line.indexOf("=")))
				.filter((name) => name.length > 0 && !["PWD", "SHLVL", "_", "OLDPWD"].includes(name))
				.sort();
			expect(names).toEqual(["HOME", "LANG", "LC_ALL", "PATH", "TERM", "TMPDIR"]);
		} finally {
			delete process.env.WORKSHOP_TARGET_SECRET;
			delete process.env.WORKSHOP_UNDECLARED_TOKEN;
			workshop.dispose();
		}
	}, 120_000);

	it("denies the network even when the Target's execution policy allows it", async () => {
		const dir = fixture({ manifest: PERMISSIVE_MANIFEST });
		expect(loadTarget(dir).manifest.execution.network).toBe("allow");
		const server = createServer((socket) => socket.end("reachable\n"));
		await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
		const port = (server.address() as AddressInfo).port;
		const workshop = open(dir);
		try {
			let reach;
			try {
				reach = await workshop.bash({
					argv: ["sh", "-c", `curl --max-time 5 -s http://127.0.0.1:${port}/ && echo REACHED`],
					timeoutMs: 30_000,
				});
			} catch (error) {
				if (sandboxUnavailable(error)) return;
				throw error;
			}
			expect(reach.network).toBe("deny");
			expect(reach.stdout).not.toContain("REACHED");
			expect(reach.stdout).not.toContain("reachable");
			expect(reach.exitCode).not.toBe(0);
		} finally {
			workshop.dispose();
			await new Promise<void>((settle) => server.close(() => settle()));
		}
	}, 120_000);

	it("mounts the authorable projection alone; the protected paths are not there to refuse", async () => {
		const dir = fixture();
		// They really do exist in the worktree the workshop was cut from.
		const workshop = open(dir);
		try {
			expect(existsSync(join(workshop.path, "evals/graders.yaml"))).toBe(true);
			expect(existsSync(join(workshop.path, ".env"))).toBe(true);
			expect(existsSync(join(workshop.path, "imports/tickets.jsonl"))).toBe(true);
			expect(existsSync(join(workshop.path, ".git"))).toBe(true);
			let listing;
			try {
				listing = await workshop.bash({
					argv: ["sh", "-c", "ls -A; for p in evals .env .git imports runs .ahde; do [ -e \"$p\" ] && echo \"PRESENT $p\"; done; exit 0"],
				});
			} catch (error) {
				if (sandboxUnavailable(error)) return;
				throw error;
			}
			expect(listing.exitCode).toBe(0);
			expect(listing.stdout).not.toContain("PRESENT");
			expect(listing.stdout.trim().split("\n").sort()).toEqual([
				"AGENTS.md",
				"bin",
				"data",
				"skills",
				"tools",
			]);
			expect([...listing.mounted]).toEqual([
				"AGENTS.md",
				"skills/**",
				"tools/**",
				"bin/**",
				"data/**",
			]);
			const manifest = await workshop.bash({ argv: ["sh", "-c", "test ! -e manifest.yaml"] });
			expect(manifest.exitCode).toBe(0);
			// Git is host-side. There is no repository in the mount to run it against.
			const git = await workshop.bash({ argv: ["sh", "-c", "git rev-parse --show-toplevel 2>&1; exit 0"] });
			expect(git.stdout).not.toContain(workshop.path);
		} finally {
			workshop.dispose();
		}
	}, 120_000);

	it("gives try_tool the authorable projection too, not the detached Target worktree", async () => {
		const dir = fixture();
		const protectedText = "TRACKED PRODUCT NOTE THAT IS NOT AUTHORABLE";
		writeFileSync(join(dir, "operator-notes.md"), `${protectedText}\n`);
		execFileSync("git", ["-C", dir, "add", "operator-notes.md"]);
		execFileSync("git", [
			"-C", dir, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "--amend", "--no-edit", "-q",
		]);
		const workshop = open(dir);
		try {
			workshop.write({
				path: "tools/snoop/tool.yaml",
				content: `schemaVersion: 1
name: snoop
description: List files visible to this authored tool.
parameters:
  type: object
  properties:
    probe: { type: string, minLength: 1, maxLength: 10 }
  required: [probe]
  additionalProperties: false
command:
  argv: [tools/snoop/run]
timeoutMs: 10000
maxOutputBytes: 8192
output: text
permissions:
  environment: []
  network: deny
  filesystem: read-only
`,
			});
			workshop.write({
				path: "tools/snoop/run",
				content: "#!/bin/sh\nfind . -maxdepth 2 -type f -print | sort\n[ ! -e operator-notes.md ] || cat operator-notes.md\n",
			});
			let tried;
			try {
				tried = await workshop.tryTool({ tool: "snoop", input: { probe: "files" } });
			} catch (error) {
				if (sandboxUnavailable(error)) return;
				throw error;
			}
			expect(tried.exitCode).toBe(0);
			expect(tried.stdout).not.toContain("operator-notes.md");
			expect(tried.stdout).not.toContain(protectedText);
			expect(tried.stdout).not.toContain("evals/");
			expect(tried.stdout).not.toContain(".git");
		} finally {
			workshop.dispose();
		}
	}, 120_000);

	it("applies the documented ulimit caps the backend can enforce, and says so when it cannot", async () => {
		const dir = fixture();
		const workshop = open(dir);
		try {
			let capped;
			try {
				capped = await workshop.bash({ argv: ["sh", "-c", "ulimit -t; ulimit -f; ulimit -n"] });
			} catch (error) {
				if (sandboxUnavailable(error)) return;
				throw error;
			}
			expect(capped.exitCode).toBe(0);
			const [cpu, fileBlocks, openFiles] = capped.stdout.trim().split("\n");
			expect(cpu).toBe("120");
			expect(fileBlocks).toBe(String((256 * 1024 * 1024) / 512));
			expect(openFiles).toBe("512");
			expect(capped.limits?.limits).toEqual({
				cpuSeconds: 120,
				fileSizeBytes: 256 * 1024 * 1024,
				openFiles: 512,
				processes: 256,
			});
			expect(capped.limits?.applied).toEqual(expect.arrayContaining(["t", "f", "n"]));
			// `ulimit -u` counts the operator's own processes under sandbox-exec, so
			// that backend reports it unenforced instead of applying a booby trap.
			if (capped.sandbox === "bwrap") {
				expect(capped.limits?.unenforced).toEqual([]);
				expect(capped.note).toBeNull();
			} else {
				expect(capped.limits?.unenforced).toEqual(["u"]);
				expect(capped.note).toMatch(/could not enforce ulimit -u/);
			}
		} finally {
			workshop.dispose();
		}
	}, 120_000);
});

describe("a tool that wants more than the profile grants", () => {
	function workbenchOn(dir: string): AhdeWorkbench {
		return createAhdeWorkbench({
			projectDir: dir,
			stateRoot: join(dir, ".ahde"),
			runsRoot: join(dir, "runs"),
			projectId: "workshop-target",
		});
	}

	it("refuses the try by default and runs it once the host says yes", async () => {
		const dir = fixture({ manifest: PERMISSIVE_MANIFEST });
		const workbench = workbenchOn(dir);
		const workshop = open(dir);
		// The Workbench needs its own open workshop, so drive it through the
		// application object the host actually calls.
		(workbench as unknown as { workshop: BuilderWorkshop }).workshop = workshop;
		try {
			writeLookupTool(workshop);
			workshop.write({ path: "tools/lookup/tool.yaml", content: NETWORK_DESCRIPTOR });
			const requirement = workshop.describeToolGrant("lookup");
			expect(requirement?.network).toBe(true);
			expect(requirement?.wants).toEqual(["network access during setup"]);

			// No host, no exception: the profile simply refuses.
			await expect(workbench.workshopTry({ tool: "lookup", input: { term: "refunds" } }))
				.rejects.toThrow(/wants network access.*no host here to allow it once/s);

			// A host that declines is still a refusal.
			const declining: WorkbenchHumanGate = {
				confirm: vi.fn(async () => ({ approved: false })),
				selectSealed: vi.fn(async () => ({ approved: false })),
			};
			await expect(workbench.workshopTry({ tool: "lookup", input: { term: "refunds" } }, { gate: declining }))
				.rejects.toThrow(/did not allow lookup network access/);

			// One exact question for one exact invocation, in the operator's words.
			const asked: WorkbenchConfirmation[] = [];
			const allowing: WorkbenchHumanGate = {
				confirm: vi.fn(async (confirmation: WorkbenchConfirmation) => {
					asked.push(confirmation);
					return { approved: true, actorId: "local:test-human" };
				}),
				selectSealed: vi.fn(async () => ({ approved: false })),
			};
			let tried;
			try {
				tried = await workbench.workshopTry({ tool: "lookup", input: { term: "refunds" } }, { gate: allowing });
			} catch (error) {
				if (sandboxUnavailable(error)) return;
				throw error;
			}
			expect(tried.exitCode).toBe(0);
			expect(asked).toHaveLength(1);
			expect(asked[0]?.kind).toBe("workshop-grant");
			expect(asked[0]?.policy).toBe("one-question");
			expect(asked[0]?.question).toBe("This tool wants network access during setup — allow for this exact try?");

			// The grant is one-shot: even identical bytes need a new human action.
			await workbench.workshopTry({ tool: "lookup", input: { term: "refunds" } }, { gate: allowing });
			expect(asked).toHaveLength(2);
			expect(asked[1]?.subject).toMatchObject({
				tool: "lookup",
				setupNetwork: true,
				runtimeNetwork: false,
				toolDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
			});
			expect(asked[1]?.subjectHash).not.toBe(asked[0]?.subjectHash);

			// Any authored-byte change invalidates the grant, even when the tool's
			// declared capability set stayed identical.
			workshop.write({ path: "tools/lookup/lib.sh", content: "ANSWER=changed-after-grant\n" });
			await workbench.workshopTry({ tool: "lookup", input: { term: "refunds" } }, { gate: allowing });
			expect(asked).toHaveLength(3);
			expect(asked[2]?.subject).toMatchObject({
				tool: "lookup",
				network: true,
				environment: [],
				snapshotHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
			});
			expect(asked[2]?.subjectHash).not.toBe(asked[1]?.subjectHash);

			// Adding a credential request changes both bytes and capabilities and
			// therefore asks yet another exact question.
			workshop.write({
				path: "tools/lookup/tool.yaml",
				content: NETWORK_DESCRIPTOR.replace(
					"environment: []",
					"environment: [WORKSHOP_TARGET_SECRET]",
				),
			});
			await workbench.workshopTry({ tool: "lookup", input: { term: "refunds" } }, { gate: allowing });
			expect(asked).toHaveLength(4);
			expect(asked[3]?.subject).toMatchObject({
				tool: "lookup",
				network: true,
				environment: ["WORKSHOP_TARGET_SECRET"],
			});

			// And the exception travels into the diff the operator applies.
			const compiled = workshop.compile({ summary: "A tool that fetches its dependency", validationPlan: ["Re-run the basket"] });
			expect(compiled.proposal.risks.some((risk) => /operator allowed lookup network access during setup for one exact try/.test(risk))).toBe(true);
			expect(compiled.proposal.risks.some((risk) => risk.includes("local:test-human"))).toBe(true);
		} finally {
			workshop.dispose();
		}
	}, 180_000);
});

describe("try_tool closes the write → run → fix loop", () => {
	it("runs a multi-file tool the Builder just wrote, including its declared setup", async () => {
		const dir = fixture();
		const workshop = open(dir);
		try {
			// A broken first attempt: the tool the Builder wrote does not run.
			writeLookupTool(workshop);
			workshop.write({ path: "tools/lookup/run", content: "#!/bin/sh\nexit 7\n" });
			let broken;
			try {
				broken = await workshop.tryTool({ tool: "lookup", input: { term: "refunds" } });
			} catch (error) {
				if (sandboxUnavailable(error)) return;
				throw error;
			}
			expect(broken.exitCode).toBe(7);
			expect(broken.source.kind).toBe("workshop");

			// The fix, tried in the same workshop, against the same declared setup.
			workshop.write({ path: "tools/lookup/run", content: LOOKUP_RUN });
			const fixed = await workshop.tryTool({ tool: "lookup", input: { term: "refunds" } });
			expect(fixed.exitCode).toBe(0);
			expect(fixed.layout).toBe("directory");
			expect(JSON.parse(fixed.stdout)).toEqual({ answer: "authored", payload: { term: "refunds" } });
			// The declared setup ran once, inside the same sandbox, in the tool home.
			expect(fixed.setup?.ran).toBe(true);
			expect(fixed.setup?.exitCode).toBe(0);
			expect(fixed.source.changedPaths).toContain("tools/lookup/run");
			expect(fixed.source.changedPaths).toContain("manifest.yaml");

			// A try is a look: no evidence, no runs, no dirt in the checkout.
			expect(existsSync(join(dir, "runs"))).toBe(false);
			expect(execFileSync("git", ["-C", dir, "status", "--porcelain", "-uall"], { encoding: "utf8" })).toBe("");
		} finally {
			workshop.dispose();
		}
	}, 180_000);
});

describe("closing the workshop is the proposal", () => {
	it("compiles a diff that reproduces the worktree and admits through the existing contract", async () => {
		const dir = fixture();
		const workshop = open(dir);
		let compiled;
		try {
			workshop.write({ path: "AGENTS.md", content: "# Workshop Target\n\nAlways answer READY.\n" });
			writeLookupTool(workshop);
			workshop.write({ path: "data/docs/policy.md", content: "Refunds close after 30 days.\n" });
			compiled = workshop.compile({
				summary: "Give the Target a lookup tool it can actually run",
				risks: ["The tool answers from one prepared file."],
				validationPlan: ["Re-run the reviewed development basket."],
			});
			expect(compiled.proposal.decision).toBe("propose");
			expect(compiled.proposal.baseTargetSha).toBe(loadTarget(dir).gitSha);
			expect(compiled.proposal.changes.map((change) => change.path)).toEqual([
				"AGENTS.md",
				"data/docs/policy.md",
				"manifest.yaml",
				"tools/lookup/lib.sh",
				"tools/lookup/run",
				"tools/lookup/tool.yaml",
			]);
			// The same scope the intent compiler and the candidate policy enforce.
			validateCandidateProposal(compiled.proposal, {
				baseTargetSha: compiled.baseTargetSha,
				allowedPaths: [...CANDIDATE_SCOPE_POLICY.allowed],
			});
		} finally {
			// The diff is the artifact; the workshop is not.
			workshop.dispose();
		}
		expect(worktreeCount(dir)).toBe(1);

		// Applying the compiled patch to the exact base revision reproduces the
		// worktree the Builder actually ran, file by file and mode by mode.
		const patch = `${compiled.proposal.changes.map((change) => change.unifiedDiff.trimEnd()).join("\n")}\n`;
		await withDetachedWorktree({ repositoryDir: dir, ref: compiled.baseTargetSha }, (worktree) => {
			execFileSync("git", ["-C", worktree.path, "apply", "--index", "-"], { input: patch });
			expect(readFileSync(join(worktree.path, "AGENTS.md"), "utf8")).toBe("# Workshop Target\n\nAlways answer READY.\n");
			expect(readFileSync(join(worktree.path, "tools/lookup/run"), "utf8")).toBe(LOOKUP_RUN);
			expect((lstatSync(join(worktree.path, "tools/lookup/run")).mode & 0o111) !== 0).toBe(true);
			const applied = loadTarget(worktree.path);
			expect(applied.tools.map((tool) => tool.descriptor.name)).toEqual(["lookup"]);
			expect(applied.manifest.data).toEqual(["data/docs"]);
			expect(applied.manifest.execution).toEqual(loadTarget(dir).manifest.execution);
		});
	}, 120_000);

	it("records through the canonical Builder run and applies behind the human gate", async () => {
		const dir = fixture();
		const stateRoot = join(dir, ".ahde");
		const runsRoot = join(dir, "runs");
		mkdirSync(runsRoot, { recursive: true });
		const gate: WorkbenchHumanGate = {
			confirm: vi.fn(async () => ({ approved: true, actorId: "local:test-human" })),
			selectSealed: vi.fn(async () => ({ approved: false })),
		};
		const workbench = createAhdeWorkbench({ projectDir: dir, stateRoot, runsRoot, projectId: "workshop-target" });
		await workbench.submit({
			kind: "spec-draft",
			spec: {
				schemaVersion: 1,
				title: "Workshop agent",
				purpose: "Answer with the reviewed lookup.",
				users: ["operator"],
				jobs: ["answer one request"],
				inputs: ["a request"],
				allowedActions: ["call lookup"],
				successCriteria: ["answer contains READY"],
				constraints: ["no network"],
				openQuestions: [],
			},
		});
		const approved = await workbench.decide({ kind: "approve-spec", reason: "Approve for the workshop test" }, gate);

		const workshop = open(dir);
		const compiled = (() => {
			try {
				workshop.write({ path: "AGENTS.md", content: "# Workshop Target\n\nAlways answer READY.\n" });
				return workshop.compile({ summary: "Make the answer explicit", validationPlan: ["Re-run the basket"] });
			} finally {
				workshop.dispose();
			}
		})();

		const recorded = await recordBuilderAuthoredProposal({
			proposal: compiled.proposal,
			targetDir: dir,
			allowedPaths: [...CANDIDATE_SCOPE_POLICY.allowed],
			approvedSpec: { stateRoot, projectId: "workshop-target", specId: String(approved.result.approvedSpecId) },
			runsRoot,
			timeoutMs: 30_000,
		});
		expect(recorded.record.result.status).toBe("completed");
		expect(recorded.record.result.proposal?.decision).toBe("propose");
		// The admission receipt binds approved Spec + Builder run + proposal hash.
		const admission = listBuilderProposalAdmissions(stateRoot, "workshop-target")
			.find((entry) => entry.runId === recorded.record.runId);
		expect(admission).toBeDefined();
		expect(admission?.approvedSpec.specId).toBe(String(approved.result.approvedSpecId));
		expect(admission?.proposalSha256).toBe(recorded.record.artifacts.proposal?.sha256);

		const applied = applyBuilderProposal({
			repoDir: dir,
			runsRoot,
			runId: recorded.record.runId,
			requestedBranch: "candidate/workshop",
			actor: { kind: "human", id: "local:test-human" },
			reason: "The exact diff is the code the Builder ran",
		});
		expect(applied.receipt.paths).toEqual(["AGENTS.md"]);
		expect(applied.receipt.baseTargetSha).toBe(compiled.baseTargetSha);
		expect(
			execFileSync("git", ["-C", dir, "show", `${applied.receipt.candidateSha}:AGENTS.md`], { encoding: "utf8" }),
		).toBe("# Workshop Target\n\nAlways answer READY.\n");
		// Applying is the operator's move; the checkout still points at the base.
		expect(execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim())
			.toBe(compiled.baseTargetSha);
		expect(worktreeCount(dir)).toBe(1);
	}, 120_000);

	it("treats persisted workshop state as selection only and restores no grant", async () => {
		const dir = fixture({ manifest: PERMISSIVE_MANIFEST });
		const workshop = open(dir);
		let reattached: BuilderWorkshop | null = null;
		try {
			writeLookupTool(workshop);
			workshop.write({ path: "tools/lookup/tool.yaml", content: NETWORK_DESCRIPTOR });
			const requirement = workshop.describeToolGrant("lookup");
			expect(requirement).not.toBeNull();
			const snapshotHash = workshop.snapshotHash();
			workshop.grantToolAccess({
				tool: "lookup",
				wants: requirement!.wants,
				snapshotHash,
				actorId: "local:test-human",
				now: () => "2026-08-31T00:00:00.000Z",
			});
			expect(workshop.status().grants).toHaveLength(1);
			const descriptor = workshop.describe();
			expect(descriptor).not.toHaveProperty("grants");

			const target = loadTarget(dir);
			const authoring = inspectTargetAuthoringContext({
				repositoryDir: dir,
				expectedTarget: { id: target.manifest.id, gitSha: target.gitSha },
			});
			const expectedBinding = {
				basis: "improvement" as const,
				approvedSpecId: descriptor.approvedSpecId,
				source: descriptor.source!,
			};
			expect(() => reattachBuilderWorkshop({
				repositoryDir: dir,
				expectedTarget: { id: target.manifest.id, gitSha: target.gitSha },
				authoringContext: authoring.claim,
				descriptor: {
					...descriptor,
					source: { ...descriptor.source!, briefId: "brief-ffffffffffffffffffffffff" },
				},
				expectedBinding,
			})).toThrow(/Spec or evidence basis is stale/);
			// A failed reattach is not abandonment: it removes neither worktree nor
			// scratch, so the exact original descriptor can still resume.
			expect(existsSync(workshop.path)).toBe(true);
			reattached = reattachBuilderWorkshop({
				repositoryDir: dir,
				expectedTarget: { id: target.manifest.id, gitSha: target.gitSha },
				authoringContext: authoring.claim,
				descriptor,
				expectedBinding,
			});
			expect(reattached.status().grants).toEqual([]);
			await expect(reattached.tryTool({ tool: "lookup", input: { term: "refunds" } }))
				.rejects.toThrow(/operator has to allow that once/);
		} finally {
			reattached?.dispose();
			// Reattached disposal owns the same detached worktree. If construction
			// failed before that point, the original handle still owns cleanup.
			if (!reattached) workshop.dispose();
		}
	}, 120_000);
});

describe("the workshop is bound to one attempt", () => {
	it("refuses a second open, refuses every tool once closed, and stays pinned to its revision", async () => {
		const dir = fixture();
		const workshop = open(dir);
		try {
			workshop.write({ path: "AGENTS.md", content: "# Workshop Target\n\nAnswer READY.\n" });
			// The Target moved under the workshop: the diff can no longer be trusted.
			writeFileSync(join(dir, "AGENTS.md"), "# Workshop Target\n\nOperator edit.\n", "utf8");
			execFileSync("git", ["-C", dir, "add", "-A"]);
			execFileSync("git", [
				"-C", dir, "-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "operator moved on",
			]);
			expect(() => workshop.compile({ summary: "Stale" })).toThrow(/Target moved while the workshop was open/);
		} finally {
			workshop.dispose();
		}
		expect(worktreeCount(dir)).toBe(1);
	});

	it("refuses every workshop tool while none is open", async () => {
		const dir = fixture();
		const workbench = createAhdeWorkbench({
			projectDir: dir,
			stateRoot: join(dir, ".ahde"),
			runsRoot: join(dir, "runs"),
			projectId: "workshop-target",
		});
		expect(workbench.workshopOpen).toBe(false);
		expect(() => workbench.workshopRead({ path: "AGENTS.md" })).toThrow(/no workshop is open/);
		expect(() => workbench.workshopWrite({ path: "AGENTS.md", content: "x\n" })).toThrow(/no workshop is open/);
		await expect(workbench.workshopBash({ argv: ["true"] })).rejects.toThrow(/no workshop is open/);
		await expect(workbench.workshopTry({ tool: "lookup", input: {} })).rejects.toThrow(/no workshop is open/);
		await expect(workbench.submit({ kind: "workshop-discard" })).rejects.toThrow(/no workshop is open/);
		// And a workshop only opens where there is something to build or improve:
		// an approved Spec, or a conclusive evaluation. Not before either exists.
		await expect(workbench.submit({ kind: "workshop-open" }))
			.rejects.toThrow(/a workshop opens at corpus-design, ready-to-evaluate, improvement-authoring, not during spec-design/);
	});

	it("dies with its disposal even when a command left files behind", async () => {
		const dir = fixture();
		const workshop = open(dir);
		const path = workshop.path;
		writeLookupTool(workshop);
		chmodSync(join(path, "tools/lookup/run"), 0o755);
		workshop.dispose();
		expect(existsSync(path)).toBe(false);
		expect(worktreeCount(dir)).toBe(1);
		expect(execFileSync("git", ["-C", dir, "status", "--porcelain", "-uall"], { encoding: "utf8" })).toBe("");
		// Disposal is idempotent; a second one is not an error.
		expect(() => workshop.dispose()).not.toThrow();
		expect(() => workshop.read("AGENTS.md")).toThrow(/is closed/);
		rmSync(join(dir, "runs"), { recursive: true, force: true });
	});
});

describe("the reviewed diff is the code that ran", () => {
	it("refuses to close when a file inside the scope is one Git ignores", async () => {
		const dir = fixture({ gitignore: ".ahde/\nruns/\nnode_modules/\n" });
		const workshop = open(dir);
		try {
			writeLookupTool(workshop);
			// A dependency directory the tool needs at runtime and Git will not
			// carry. It would silently vanish from the reviewed proposal.
			workshop.write({ path: "tools/lookup/node_modules/left-pad/index.js", content: "module.exports = 1;\n" });
			expect(workshop.ignoredInScope()).toEqual(["tools/lookup/node_modules/left-pad/index.js"]);
			try {
				const tried = await workshop.tryTool({ tool: "lookup", input: { term: "refunds" } });
				expect(tried.exitCode).toBe(0);
				expect(tried.source.snapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/);
			} catch (error) {
				if (!sandboxUnavailable(error)) throw error;
			}
			expect(() => workshop.compile({ summary: "A tool with a dependency" }))
				.toThrow(/tools\/lookup\/node_modules\/left-pad\/index\.js.*Git ignores/s);
			// Removing it makes the close legal again, so the refusal is a fix, not a wall.
			workshop.write({ path: "tools/lookup/node_modules/left-pad/index.js", remove: true });
			expect(workshop.compile({ summary: "A tool with no dependency", validationPlan: ["Re-run"] }).changes.length)
				.toBeGreaterThan(0);
		} finally {
			workshop.dispose();
		}
	}, 180_000);

	it("catches an ignored file a command produced, not only one a write produced", async () => {
		const dir = fixture({ gitignore: ".ahde/\nruns/\nbuild/\n" });
		const workshop = open(dir);
		try {
			workshop.write({ path: "tools/lookup/tool.yaml", content: LOOKUP_DESCRIPTOR });
			try {
				const made = await workshop.bash({
					argv: ["sh", "-c", "mkdir -p tools/lookup/build && printf 'artifact\\n' > tools/lookup/build/out"],
				});
				expect(made.exitCode).toBe(0);
			} catch (error) {
				if (sandboxUnavailable(error)) return;
				throw error;
			}
			expect(readFileSync(join(workshop.path, "tools/lookup/build/out"), "utf8")).toBe("artifact\n");
			expect(workshop.ignoredInScope()).toEqual(["tools/lookup/build/out"]);
			expect(() => workshop.compile({ summary: "Built artifact" }))
				.toThrow(/tools\/lookup\/build\/out.*Git ignores/s);
		} finally {
			workshop.dispose();
		}
	}, 180_000);

	it("compiles the diff from one snapshot and reports the snapshot a try ran against", () => {
		const dir = fixture();
		const workshop = open(dir);
		try {
			const empty = workshop.snapshotHash();
			workshop.write({ path: "AGENTS.md", content: "# Workshop Target\n\nAnswer READY.\n" });
			const written = workshop.snapshotHash();
			expect(written).not.toBe(empty);
			// Writing the same bytes back is the same snapshot, byte for byte.
			workshop.write({ path: "AGENTS.md", content: "# Workshop Target\n\nAnswer READY.\n" });
			expect(workshop.snapshotHash()).toBe(written);
			expect(workshop.status().snapshotHash).toBe(written);
			const compiled = workshop.compile({ summary: "Make it explicit", validationPlan: ["Re-run"] });
			// What was compiled is exactly what the snapshot held.
			expect(compiled.changes.map((change) => change.path)).toEqual(["AGENTS.md"]);
			expect(compiled.proposal.changes[0]?.unifiedDiff).toContain("Answer READY.");
			expect(workshop.snapshotHash()).toBe(written);
		} finally {
			workshop.dispose();
		}
	});

	it("marks every registered Builder tool sequential, so write and close cannot race", () => {
		const dir = fixture();
		const tools = createAhdeBuilderTools({
			projectDir: dir,
			stateRoot: join(dir, ".ahde"),
			runsRoot: join(dir, "runs"),
			projectId: "workshop-target",
		});
		expect(tools.map((tool) => tool.name)).toEqual([
			"ahde_workbench_view",
			"ahde_workbench_submit",
			"ahde_workbench_decide",
			"ahde_workshop_read",
			"ahde_workshop_write",
			"ahde_workshop_bash",
			"ahde_workshop_author_tool",
			"ahde_workshop_try",
		]);
		for (const tool of tools) {
			expect(tool.executionMode, tool.name).toBe("sequential");
		}
	});
});

describe("the construction workshop", () => {
	const SPEC = {
		schemaVersion: 1 as const,
		title: "Workshop agent",
		purpose: "Answer with the reviewed lookup.",
		users: ["operator"],
		jobs: ["answer one request"],
		inputs: ["a request"],
		allowedActions: ["call lookup"],
		successCriteria: ["answer contains READY"],
		constraints: ["no network"],
		openQuestions: [] as string[],
	};

	function approvingGate(): WorkbenchHumanGate {
		return {
			confirm: vi.fn(async () => ({ approved: true, actorId: "local:test-human" })),
			selectSealed: vi.fn(async () => ({ approved: false })),
		};
	}

	/** A project whose Spec is approved and whose agent has not been built yet. */
	async function specApproved(dir: string): Promise<{
		workbench: AhdeWorkbench;
		stateRoot: string;
		runsRoot: string;
		gate: WorkbenchHumanGate;
		approvedSpecId: string;
	}> {
		const stateRoot = join(dir, ".ahde");
		const runsRoot = join(dir, "runs");
		mkdirSync(runsRoot, { recursive: true });
		const gate = approvingGate();
		const workbench = createAhdeWorkbench({ projectDir: dir, stateRoot, runsRoot, projectId: "workshop-target" });
		await workbench.submit({ kind: "spec-draft", spec: SPEC });
		const approved = await workbench.decide({ kind: "approve-spec", reason: "Approve so the agent can be built" }, gate);
		return { workbench, stateRoot, runsRoot, gate, approvedSpecId: String(approved.result.approvedSpecId) };
	}

	it("opens on the approved Spec, before any evaluation has ever run", async () => {
		const dir = fixture();
		const { workbench } = await specApproved(dir);
		try {
			expect((await workbench.view()).stage).toBe("corpus-design");
			const opened = await workbench.submit({ kind: "workshop-open" });
			expect(opened.kind).toBe("workshop-open");
			expect(opened.artifact?.basis).toBe("construction");
			expect(workbench.workshopStatus().basis).toBe("construction");
			// The five hands work here exactly as they do after a diagnosis.
			workbench.workshopWrite({ path: "AGENTS.md", content: "# Workshop Target\n\nAnswer READY.\n" });
			expect(workbench.workshopRead({ path: "AGENTS.md" }).content).toContain("READY");
		} finally {
			workbench.closeWorkshop();
		}
	}, 120_000);

	it("turns a conversational brief into a reviewed, contract-tested package", async () => {
		const dir = fixture();
		const { workbench, gate } = await specApproved(dir);
		await workbench.submit({ kind: "workshop-open" });
		const authored = await workbench.workshopAuthorTool({
			name: "health_check",
			purpose: "Report whether the configured service can answer.",
			dataSource: "A deterministic local service adapter for the first version.",
			parameters: {
				type: "object",
				properties: { simulateError: { type: "boolean" } },
				required: [],
				additionalProperties: false,
			},
			output: {
				format: "json",
				description: "Service health.",
				schema: {
					type: "object",
					properties: { ok: { type: "boolean" } },
					required: ["ok"],
					additionalProperties: false,
				},
			},
			errors: [{ condition: "The service is unavailable", behavior: "Exit 2 and explain it on stderr." }],
			permissions: { network: "deny", filesystem: "read-only", process: "sandboxed-subprocess" },
			credentials: [],
			implementation:
				"#!/bin/sh\ninput=$(cat)\ncase \"$input\" in *'\"simulateError\":true'*) printf 'service unavailable\\n' >&2; exit 2;; esac\nprintf '{\"ok\":true}\\n'\n",
			supportFiles: [],
			fixtures: [
				{ name: "healthy", covers: "happy-path", input: {}, expect: { exitCode: 0, jsonEquals: { ok: true } } },
				{ name: "service-error", covers: "error-handling", input: { simulateError: true }, expect: { exitCode: 2, stderrContains: "service unavailable" } },
			],
			timeoutMs: 10_000,
			maxOutputBytes: 8_192,
		}, { credentialBindings: {}, gate });

		expect(authored.allPassed).toBe(true);
		expect(authored.tests.map((test) => [test.name, test.passed])).toEqual([
			["healthy", true],
			["service-error", true],
		]);
		expect(vi.mocked(gate.confirm).mock.calls.at(-1)?.[0]).toMatchObject({
			kind: "tool-authoring",
			subject: {
				capabilities: { network: "deny", filesystem: "read-only", process: "sandboxed-subprocess" },
			},
		});

		const closed = await workbench.submit({
			kind: "workshop-close",
			summary: "Build the health-check tool",
			risks: ["The real service adapter is still needed."],
			validationPlan: ["Verify agent routing and final answers."],
		});
		expect(closed.artifact?.permissions).toEqual([expect.objectContaining({ tool: "health_check" })]);
		expect(closed.artifact?.toolTests).toEqual(expect.arrayContaining([
			expect.objectContaining({ test: "healthy", passed: true }),
			expect.objectContaining({ test: "service-error", passed: true }),
		]));
		expect(closed.artifact?.changedPaths).toEqual(expect.arrayContaining([
			"added tools/health_check/run",
			"added tools/health_check/tool.yaml",
		]));
	}, 120_000);

	it("closes into the ordinary proposal with no evidence behind it", async () => {
		const dir = fixture();
		const { workbench, stateRoot, runsRoot } = await specApproved(dir);
		await workbench.submit({ kind: "workshop-open" });
		workbench.workshopWrite({ path: "AGENTS.md", content: "# Workshop Target\n\nAnswer READY.\n" });
		workbench.workshopWrite({ path: "tools/lookup/tool.yaml", content: LOOKUP_DESCRIPTOR });
		workbench.workshopWrite({ path: "tools/lookup/run", content: LOOKUP_RUN });
		workbench.workshopWrite({ path: "tools/lookup/lib.sh", content: "ANSWER=authored\n" });

		// A construction close may not cite evidence that does not exist.
		await expect(workbench.submit({
			kind: "workshop-close",
			summary: "Build the first harness",
			source: {
				algorithmId: "exact-eval-signals-v1",
				evalRunId: "erun_0000000000000000",
				diagnosisId: "diag_0000000000000000",
				briefId: "brief-000000000000000000000000",
			},
			failureModeIds: ["failure-mode-000000000000000000000000"],
			validationPlan: ["Run the first basket"],
		})).rejects.toThrow(/construction workshop has no evaluation to cite/);

		const closed = await workbench.submit({
			kind: "workshop-close",
			summary: "Build the first harness from the approved Spec",
			risks: ["Nothing has been measured yet."],
			validationPlan: ["Draft a basket and run it."],
		});
		expect(closed.artifact?.basis).toBe("construction");
		expect(closed.artifact?.sourceEvalRunId).toBeNull();
		expect(closed.artifact?.failureModeIds).toEqual([]);
		expect(closed.view.stage).toBe("proposal-review");
		const runId = String(closed.artifact?.runId);

		// Recorded through the one canonical service, with no source evidence…
		const record = loadBuilderProposalRun(runsRoot, runId);
		expect(record.request.source).toBeNull();
		expect(record.result.proposal?.decision).toBe("propose");
		// …and admitted through the same receipt every other proposal passes.
		const admission = listBuilderProposalAdmissions(stateRoot, "workshop-target")
			.find((entry) => entry.runId === runId);
		expect(admission).toBeDefined();
		expect(admission?.proposalSha256).toBe(record.artifacts.proposal?.sha256);

		// And the human apply gate is the unchanged one.
		const applied = applyBuilderProposal({
			repoDir: dir,
			runsRoot,
			runId,
			requestedBranch: "candidate/construction",
			actor: { kind: "human", id: "local:test-human" },
			reason: "Build the agent the Spec describes",
		});
		expect(applied.receipt.paths).toEqual([
			"AGENTS.md",
			"manifest.yaml",
			"tools/lookup/lib.sh",
			"tools/lookup/run",
			"tools/lookup/tool.yaml",
		]);
		expect(worktreeCount(dir)).toBe(1);
	}, 180_000);

	it("reopens a closed proposal into a new workshop seeded from its diff", async () => {
		const dir = fixture();
		const { workbench, gate } = await specApproved(dir);
		await workbench.submit({ kind: "workshop-open" });
		workbench.workshopWrite({ path: "AGENTS.md", content: "# Workshop Target\n\nFirst attempt.\n" });
		const closed = await workbench.submit({
			kind: "workshop-close",
			summary: "First attempt at the harness",
			validationPlan: ["Draft a basket"],
		});
		const runId = String(closed.artifact?.runId);
		// The operator reads the diff and wants it changed rather than applied.
		await workbench.decide({ kind: "discard-proposal", runId, reason: "Close, but the wording is wrong" }, gate);

		const reopened = await workbench.submit({ kind: "workshop-open", fromProposalRunId: runId });
		expect(reopened.artifact?.fromProposalRunId).toBe(runId);
		// The workshop already holds exactly what that proposal changed.
		expect(workbench.workshopRead({ path: "AGENTS.md" }).content).toBe("# Workshop Target\n\nFirst attempt.\n");
		expect(reopened.artifact?.changedPaths).toEqual(["modified AGENTS.md"]);
		workbench.closeWorkshop();
	}, 180_000);

	it("survives a Builder restart on a matching snapshot and fails closed on a mismatch", async () => {
		const dir = fixture();
		const { workbench, stateRoot, runsRoot } = await specApproved(dir);
		const opened = await workbench.submit({ kind: "workshop-open" });
		const workshopId = String(opened.artifact?.workshopId);
		workbench.workshopWrite({ path: "AGENTS.md", content: "# Workshop Target\n\nHalf-written.\n" });
		expect(workbench.workshopStatus().snapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/);

		// The Builder process dies. Its worktree and its note under the project
		// state outlive it; the in-memory workshop does not.
		const restarted = createAhdeWorkbench({ projectDir: dir, stateRoot, runsRoot, projectId: "workshop-target" });
		expect(restarted.workshopOpen).toBe(false);
		const reattached = await restarted.submit({ kind: "workshop-open", workshopId });
		expect(reattached.artifact?.reattached).toBe(true);
		expect(reattached.artifact?.workshopId).toBe(workshopId);
		expect(restarted.workshopRead({ path: "AGENTS.md" }).content).toBe("# Workshop Target\n\nHalf-written.\n");
		const path = (restarted as unknown as { workshop: BuilderWorkshop }).workshop.path;

		// A workshop nobody can vouch for byte-for-byte is not the one that was
		// left open. Somebody edited the worktree behind the Workbench's back.
		const second = createAhdeWorkbench({ projectDir: dir, stateRoot, runsRoot, projectId: "workshop-target" });
		writeFileSync(join(path, "AGENTS.md"), "# Workshop Target\n\nTampered.\n", "utf8");
		await expect(second.submit({ kind: "workshop-open", workshopId }))
			.rejects.toThrow(/changed on disk .*discard it and open a new one/s);
		// An id nobody recorded grants nothing either.
		await expect(second.submit({ kind: "workshop-open", workshopId: "workshop_00000000000000ff" }))
			.rejects.toThrow(/no workshop workshop_00000000000000ff is recorded/);
		restarted.closeWorkshop();
	}, 180_000);

	it("keeps the original approved Spec across mutable focus and refuses a rebind", async () => {
		const dir = fixture();
		const { workbench, stateRoot, runsRoot, gate, approvedSpecId } = await specApproved(dir);
		const opened = await workbench.submit({ kind: "workshop-open" });
		const workshopId = String(opened.artifact?.workshopId);
		workbench.workshopWrite({ path: "AGENTS.md", content: "# Workshop Target\n\nBound to Spec A.\n" });

		// A newly approved Spec becomes focus, but focus is selection state. It may
		// neither redirect recovery nor change what this workshop will close under.
		await workbench.submit({
			kind: "spec-draft",
			spec: { ...SPEC, title: "Workshop agent version B", purpose: "A different approved purpose." },
		});
		const approvedB = await workbench.decide({ kind: "approve-spec", reason: "Approve a second exact Spec" }, gate);
		const approvedSpecIdB = String(approvedB.result.approvedSpecId);
		expect(approvedSpecIdB).not.toBe(approvedSpecId);
		await expect(workbench.submit({
			kind: "workshop-close",
			approvedSpecId: approvedSpecIdB,
			summary: "Attempt to rebind at close",
			validationPlan: ["Must not run"],
		})).rejects.toThrow(/does not match the workshop's immutable binding/);
		workbench.suspendWorkshop();

		const restarted = createAhdeWorkbench({ projectDir: dir, stateRoot, runsRoot, projectId: "workshop-target" });
		await expect(restarted.submit({
			kind: "workshop-open",
			workshopId,
			approvedSpecId: approvedSpecIdB,
		})).rejects.toThrow(/does not match the recorded workshop/);
		// The refusal was non-destructive and recovery still derives Spec A by id,
		// independently of the new focus.
		const resumed = await restarted.submit({ kind: "workshop-open", workshopId });
		expect(resumed.artifact?.approvedSpecId).toBe(approvedSpecId);
		expect(restarted.workshopRead({ path: "AGENTS.md" }).content).toContain("Bound to Spec A");
		restarted.closeWorkshop();
	}, 180_000);

	it("refuses a stale construction/improvement basis without deleting recovery state", async () => {
		const dir = fixture();
		const { workbench, stateRoot, runsRoot } = await specApproved(dir);
		const opened = await workbench.submit({ kind: "workshop-open" });
		const workshopId = String(opened.artifact?.workshopId);
		workbench.workshopWrite({ path: "AGENTS.md", content: "# Workshop Target\n\nRecover me.\n" });
		workbench.suspendWorkshop();
		const statePath = join(stateRoot, "projects", "workshop-target", "workbench", "workshop.json");
		const original = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
		const tampered = {
			...original,
			basis: "improvement",
			source: {
				algorithmId: "exact-eval-signals-v1",
				evalRunId: "erun_stale",
				diagnosisId: "diag_stale",
				briefId: "brief-ffffffffffffffffffffffff",
			},
		};
		writeFileSync(statePath, `${JSON.stringify(tampered)}\n`);
		const restarted = createAhdeWorkbench({ projectDir: dir, stateRoot, runsRoot, projectId: "workshop-target" });
		await expect(restarted.submit({ kind: "workshop-open", workshopId }))
			.rejects.toThrow(/basis changed from improvement to construction/);
		expect(existsSync(String(original.worktreePath))).toBe(true);
		expect(existsSync(statePath)).toBe(true);

		// Restore the exact host note and prove the rejected reattach left a usable
		// workshop rather than an orphan.
		writeFileSync(statePath, `${JSON.stringify(original)}\n`);
		const recovered = createAhdeWorkbench({ projectDir: dir, stateRoot, runsRoot, projectId: "workshop-target" });
		await recovered.submit({ kind: "workshop-open", workshopId });
		expect(recovered.workshopRead({ path: "AGENTS.md" }).content).toContain("Recover me");
		recovered.closeWorkshop();
	}, 180_000);

	it("restores consumed-grant disclosure after a crash but never live authority", async () => {
		const dir = fixture({ manifest: PERMISSIVE_MANIFEST });
		const { workbench, stateRoot, runsRoot, gate } = await specApproved(dir);
		const opened = await workbench.submit({ kind: "workshop-open" });
		const workshopId = String(opened.artifact?.workshopId);
		workbench.workshopWrite({ path: "tools/lookup/tool.yaml", content: NETWORK_DESCRIPTOR });
		workbench.workshopWrite({ path: "tools/lookup/run", content: LOOKUP_RUN });
		workbench.workshopWrite({ path: "tools/lookup/lib.sh", content: "ANSWER=audited\n" });
		try {
			await workbench.workshopTry({ tool: "lookup", input: { term: "refunds" } }, { gate });
		} catch (error) {
			if (!sandboxUnavailable(error)) throw error;
		}

		// Simulate a hard process loss: do not call suspend/close on the old object.
		const restarted = createAhdeWorkbench({ projectDir: dir, stateRoot, runsRoot, projectId: "workshop-target" });
		await restarted.submit({ kind: "workshop-open", workshopId });
		expect(restarted.workshopStatus().grants).toEqual([
			expect.objectContaining({
				workshopId,
				tool: "lookup",
				used: true,
				actorId: "local:test-human",
				consumedAt: expect.any(String),
			}),
		]);
		await expect(restarted.workshopTry({ tool: "lookup", input: { term: "refunds" } }))
			.rejects.toThrow(/no host here to allow it once/);

		const closed = await restarted.submit({
			kind: "workshop-close",
			summary: "Keep the attempted network setup disclosure",
			validationPlan: ["Run the reviewed basket"],
		});
		const proposal = loadBuilderProposalRun(runsRoot, String(closed.artifact?.runId)).result.proposal;
		expect(proposal?.risks).toEqual(expect.arrayContaining([
			expect.stringMatching(/operator allowed lookup network access during setup for one exact try/i),
		]));
	}, 180_000);

	it("suspends on graceful shutdown and resumes the exact work with fresh runtime scratch", async () => {
		const dir = fixture();
		const { workbench, stateRoot, runsRoot } = await specApproved(dir);
		const opened = await workbench.submit({ kind: "workshop-open" });
		const workshopId = String(opened.artifact?.workshopId);
		workbench.workshopWrite({ path: "AGENTS.md", content: "# Workshop Target\n\nResume after shutdown.\n" });
		const statePath = join(stateRoot, "projects", "workshop-target", "workbench", "workshop.json");
		const descriptor = JSON.parse(readFileSync(statePath, "utf8")) as { worktreePath: string; scratchRoot: string };
		mkdirSync(join(descriptor.scratchRoot, "leftover"), { recursive: true });
		writeFileSync(join(descriptor.scratchRoot, "leftover/runtime.txt"), "temporary\n");

		workbench.suspendWorkshop();
		expect(workbench.workshopOpen).toBe(false);
		expect(existsSync(statePath)).toBe(true);
		expect(existsSync(descriptor.worktreePath)).toBe(true);
		expect(readdirSync(descriptor.scratchRoot)).toEqual([]);
		expect(worktreeCount(dir)).toBe(2);

		const restarted = createAhdeWorkbench({ projectDir: dir, stateRoot, runsRoot, projectId: "workshop-target" });
		await restarted.submit({ kind: "workshop-open", workshopId });
		expect(restarted.workshopRead({ path: "AGENTS.md" }).content).toContain("Resume after shutdown");
		restarted.closeWorkshop();
		expect(existsSync(statePath)).toBe(false);
		expect(existsSync(descriptor.worktreePath)).toBe(false);
		expect(worktreeCount(dir)).toBe(1);
	}, 180_000);

	it("never trusts a persisted cleanup path and removes an abandoned crash-surviving worktree", async () => {
		const dir = fixture();
		const { workbench, stateRoot, runsRoot } = await specApproved(dir);
		const first = await workbench.submit({ kind: "workshop-open" });
		const firstId = String(first.artifact?.workshopId);
		const firstPath = (workbench as unknown as { workshop: BuilderWorkshop }).workshop.path;
		workbench.workshopWrite({ path: "AGENTS.md", content: "# Workshop Target\n\nCrash survivor.\n" });

		// A new process chooses a new workshop instead of re-attaching. The old
		// validated worktree is removed first; only the new one remains registered.
		const restarted = createAhdeWorkbench({ projectDir: dir, stateRoot, runsRoot, projectId: "workshop-target" });
		const replacement = await restarted.submit({ kind: "workshop-open" });
		expect(replacement.artifact?.workshopId).not.toBe(firstId);
		expect(existsSync(firstPath)).toBe(false);
		expect(worktreeCount(dir)).toBe(2);
		restarted.closeWorkshop();
		workbench.closeWorkshop();

		// Persisted state may be edited, but it may never turn cleanup into an
		// arbitrary recursive delete.
		const opened = await workbench.submit({ kind: "workshop-open" });
		const workshopId = String(opened.artifact?.workshopId);
		const protectedDir = mkdtempSync(join(tmpdir(), "ahde-protected-cleanup-"));
		const marker = join(protectedDir, "keep.txt");
		writeFileSync(marker, "keep\n");
		try {
			const statePath = join(stateRoot, "projects", "workshop-target", "workbench", "workshop.json");
			const descriptor = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
			descriptor.scratchRoot = protectedDir;
			writeFileSync(statePath, `${JSON.stringify(descriptor)}\n`);
			const tampered = createAhdeWorkbench({ projectDir: dir, stateRoot, runsRoot, projectId: "workshop-target" });
			await expect(tampered.submit({ kind: "workshop-open", workshopId }))
				.rejects.toThrow(/unsafe workshop scratch directory/);
			expect(readFileSync(marker, "utf8")).toBe("keep\n");
		} finally {
			workbench.closeWorkshop();
			rmSync(protectedDir, { recursive: true, force: true });
		}
	}, 180_000);
});
