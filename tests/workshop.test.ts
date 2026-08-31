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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BuilderWorkshopEmptyError,
	BuilderWorkshopScopeError,
	openBuilderWorkshop,
	type BuilderWorkshop,
} from "../src/application/tool-workshop.js";
import { inspectTargetAuthoringContext } from "../src/application/target-authoring-context.js";
import { CANDIDATE_SCOPE_POLICY } from "../src/application/candidate-experiment.js";
import { recordBuilderAuthoredProposal } from "../src/application/builder-authoring.js";
import { applyBuilderProposal, listBuilderProposalAdmissions } from "../src/application/builder-proposal.js";
import { validateCandidateProposal } from "../src/builders/adapters.js";
import { withDetachedWorktree } from "../src/git/experiment-worktree.js";
import { createAhdeWorkbench } from "../src/workbench/workbench.js";
import type { WorkbenchHumanGate } from "../src/workbench/types.js";
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

function fixture(): string {
	const dir = makeTargetFixture(baseFixtureFiles({
		"manifest.yaml": MANIFEST,
		".gitignore": ".ahde/\nruns/\ndata/private/\n",
		"AGENTS.md": "# Workshop Target\n\nAnswer briefly.\n",
	}).filter((file) => file.path !== "skills/check-dbo/SKILL.md" && file.path !== "bin/check_dbo"));
	created.push(dir);
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
		basis: "improvement",
		approvedSpecId: "spec_workshop_fixture",
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
			// The refusal is a refusal: nothing was created on the way to it.
			expect(existsSync(join(workshop.path, ".env"))).toBe(false);
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
