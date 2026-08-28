import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	importBuilderCorpusDraft,
	loadBuilderCorpusImportReceipt,
} from "../src/application/builder-corpus-import.js";
import { loadBuilderCorpusDraft } from "../src/application/builder-corpus-draft.js";
import { listCorpora } from "../src/corpus.js";
import { loadApprovedSpec, saveSpecSnapshot, type AgentSpec } from "../src/spec.js";

const NOW = "2026-08-28T12:00:00.000Z";
const LATER = "2026-08-28T13:00:00.000Z";
const roots: string[] = [];

function root(prefix = "ahde-builder-corpus-import-"): string {
	const path = mkdtempSync(join(tmpdir(), prefix));
	roots.push(path);
	return path;
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function spec(): AgentSpec {
	return {
		schemaVersion: 1,
		title: "Policy assistant",
		purpose: "Answer policy questions from approved evidence.",
		users: ["Support operators"],
		jobs: ["Answer policy questions"],
		inputs: ["A policy question"],
		allowedActions: ["Read local policy documents"],
		successCriteria: ["Answer contains the applicable policy"],
		constraints: ["Never invent a policy"],
		openQuestions: [],
	};
}

function fixture() {
	const projectDir = root();
	const stateRoot = join(projectDir, ".ahde");
	const runsRoot = join(projectDir, "runs");
	const snapshot = saveSpecSnapshot({
		stateRoot,
		projectId: "policy",
		status: "approved",
		spec: spec(),
		now: () => NOW,
	});
	return {
		projectDir,
		stateRoot,
		runsRoot,
		approvedSpec: loadApprovedSpec({ stateRoot, projectId: "policy", specId: snapshot.id }).reference,
	};
}

function sourceContent(): string {
	return [
		JSON.stringify({
			id: "legacy-refund",
			input: "What is the refund window?",
			graders: [{ type: "output_contains", text: "30 days" }],
		}),
		JSON.stringify({
			id: "legacy-unknown",
			input: "What if the policy is absent?",
			graders: [{ type: "output_matches", pattern: "unknown|not found" }],
		}),
	].join("\n") + "\n";
}

describe("Builder corpus JSONL import", () => {
	it("creates an editable Spec-bound draft and immutable exact-source receipt without publishing", () => {
		const paths = fixture();
		mkdirSync(join(paths.projectDir, "imports"));
		const raw = sourceContent();
		writeFileSync(join(paths.projectDir, "imports", "policy.jsonl"), raw, "utf8");
		const options = {
			...paths,
			sourcePath: "imports/policy.jsonl",
			name: "Imported policy cases",
			coverageNotes: ["Imported operator examples"],
			revisionSummary: "Import reviewed development examples",
		};

		const first = importBuilderCorpusDraft(options, { now: () => NOW });
		const repeated = importBuilderCorpusDraft(options, { now: () => LATER });

		expect(first.draft).toMatchObject({
			projectId: "policy",
			approvedSpec: paths.approvedSpec,
			parentDraftId: null,
			name: "Imported policy cases",
		});
		expect(first.draft.tasks.map((task) => task.id)).toEqual([
			expect.stringMatching(/^task-[0-9a-f]{64}$/),
			expect.stringMatching(/^task-[0-9a-f]{64}$/),
		]);
		expect(first.draft.tasks.map((task) => task.id)).not.toEqual(["legacy-refund", "legacy-unknown"]);
		expect(first.draft.importSource).toMatchObject({ path: "imports/policy.jsonl", taskCount: 2 });
		expect(first.receipt).toMatchObject({
			kind: "builder-corpus-import",
			projectId: "policy",
			approvedSpec: paths.approvedSpec,
			draftId: first.draft.id,
			source: {
				path: "imports/policy.jsonl",
				sha256: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
				bytes: Buffer.byteLength(raw),
				taskCount: 2,
			},
			createdAt: NOW,
		});
		expect(repeated).toEqual(first);
		expect(loadBuilderCorpusDraft(paths.stateRoot, "policy", first.draft.id)).toEqual(first.draft);
		expect(loadBuilderCorpusImportReceipt(paths.stateRoot, "policy", first.receipt.id)).toEqual(first.receipt);
		expect(existsSync(first.receiptPath)).toBe(true);
		expect(listCorpora({ stateRoot: paths.stateRoot, projectId: "policy" })).toEqual([]);
	});

	it("rejects traversal, hidden/private paths, symlink components, and run evidence", () => {
		const paths = fixture();
		const outside = root("ahde-builder-corpus-import-outside-");
		writeFileSync(join(outside, "outside.jsonl"), sourceContent(), "utf8");
		mkdirSync(join(paths.projectDir, "imports"));
		symlinkSync(outside, join(paths.projectDir, "imports", "linked"), "dir");
		mkdirSync(paths.runsRoot);
		writeFileSync(join(paths.runsRoot, "evidence.jsonl"), sourceContent(), "utf8");
		mkdirSync(join(paths.projectDir, "evals"));
		writeFileSync(join(paths.projectDir, "evals", "sealed.jsonl"), sourceContent(), "utf8");

		const base = {
			...paths,
			name: "Unsafe import",
			revisionSummary: "Must fail",
		};
		for (const sourcePath of [
			"../outside.jsonl",
			join(outside, "outside.jsonl"),
			".ahde/private.jsonl",
			"evals/sealed.jsonl",
			"imports/linked/outside.jsonl",
			"runs/evidence.jsonl",
		]) {
			expect(() => importBuilderCorpusDraft({ ...base, sourcePath })).toThrow(
				/normalized project-relative|Builder inbox|forbidden path|symlink|private AHDE state|run evidence/,
			);
		}
		expect(existsSync(join(paths.stateRoot, "projects", "policy", "builder-corpus-drafts"))).toBe(false);
	});

	it("fails closed on malformed, duplicate, oversized, or excessive JSONL before creating a draft", () => {
		const cases = [
			["malformed.jsonl", "{not-json}\n", /invalid JSON at line 1/],
			[
				"duplicate.jsonl",
				`${JSON.stringify({ id: "same", input: "A", graders: [{ type: "output_contains", text: "A" }] })}\n${JSON.stringify({ id: "same", input: "B", graders: [{ type: "output_contains", text: "B" }] })}\n`,
				/duplicate source id/,
			],
			[
				"many.jsonl",
				Array.from({ length: 101 }, (_, index) => JSON.stringify({
					id: `case-${index}`,
					input: `Question ${index}`,
					graders: [{ type: "output_contains", text: String(index) }],
				})).join("\n") + "\n",
				/exceeds 100 tasks/,
			],
			["large.jsonl", "x".repeat(2 * 1024 * 1024 + 1), /exceeds 2097152 bytes/],
		] as const;

		for (const [filename, content, expected] of cases) {
			const paths = fixture();
			mkdirSync(join(paths.projectDir, "imports"));
			writeFileSync(join(paths.projectDir, "imports", filename), content);
			expect(() => importBuilderCorpusDraft({
				...paths,
				sourcePath: `imports/${filename}`,
				name: "Rejected import",
				revisionSummary: "Must fail",
			})).toThrow(expected);
			expect(existsSync(join(paths.stateRoot, "projects", "policy", "builder-corpus-drafts"))).toBe(false);
		}
	});

	it("detects receipt tampering when the import is loaded after restart", () => {
		const paths = fixture();
		mkdirSync(join(paths.projectDir, "imports"));
		writeFileSync(join(paths.projectDir, "imports", "policy.jsonl"), sourceContent(), "utf8");
		const imported = importBuilderCorpusDraft({
			...paths,
			sourcePath: "imports/policy.jsonl",
			name: "Policy cases",
			revisionSummary: "Import",
		}, { now: () => NOW });
		const stored = JSON.parse(readFileSync(imported.receiptPath, "utf8")) as Record<string, unknown>;
		writeFileSync(imported.receiptPath, `${JSON.stringify({ ...stored, draftHash: `sha256:${"0".repeat(64)}` })}\n`, "utf8");

		expect(() => loadBuilderCorpusImportReceipt(paths.stateRoot, "policy", imported.receipt.id))
			.toThrow(/import id does not match its exact provenance/);
	});
});
