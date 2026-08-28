import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	applyTargetScaffold,
	describeTargetScaffold,
	TargetScaffoldReceiptSchema,
	type ApplyTargetScaffoldOptions,
} from "../src/application/target-scaffold.js";
import { hashValue } from "../src/provenance.js";

const NOW = "2026-08-28T10:00:00.000Z";
const TEMPLATE_DIR = resolve("templates/basic-agent");
const cleanupPaths: string[] = [];

afterEach(() => {
	for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

interface Fixture {
	root: string;
	projectDir: string;
	stateRoot: string;
	templateDir: string;
}

function fixture(copyTemplate = false): Fixture {
	const root = mkdtempSync(join(tmpdir(), "ahde-target-scaffold-"));
	cleanupPaths.push(root);
	const projectDir = join(root, "project");
	const stateRoot = join(projectDir, ".ahde");
	mkdirSync(stateRoot, { recursive: true });
	const templateDir = copyTemplate ? join(root, "template") : TEMPLATE_DIR;
	if (copyTemplate) cpSync(TEMPLATE_DIR, templateDir, { recursive: true });
	return { root, projectDir, stateRoot, templateDir };
}

function options(value: Fixture): ApplyTargetScaffoldOptions {
	const subject = describeTargetScaffold(value);
	return {
		projectDir: value.projectDir,
		templateDir: value.templateDir,
		stateRoot: value.stateRoot,
		expectedSubjectHash: hashValue(subject),
		actor: { kind: "human", id: " operator-1 " },
		reason: " Reviewed the exact initial Target scaffold ",
	};
}

describe("Target scaffold application service", () => {
	it("describes and publishes exactly the reviewed generic Target scaffold", () => {
		const value = fixture();
		const subject = describeTargetScaffold(value);

		expect(describeTargetScaffold(value)).toEqual(subject);
		expect(subject).toMatchObject({
			operation: "initialize-current-directory",
			targetPath: value.projectDir,
			targetId: "my-agent",
			generated: {
				gitRepository: "fresh repository with one scaffold commit",
				localArtifactIgnores: ["/.ahde/", "/imports/", "/runs/", "/.env", "/.env.*", "!/.env.example"],
			},
		});
		expect(subject.templateFiles.map((file) => file.path)).toEqual([
			"AGENTS.md",
			"bin/echo_json",
			"evals/development.jsonl",
			"evals/graders.yaml",
			"manifest.yaml",
			"tools/echo_json.tool.yaml",
		]);
		expect(subject.templateHash).toBe(hashValue(subject.templateFiles));

		const result = applyTargetScaffold(options(value), { now: () => NOW });
		const ignoreFile = readFileSync(join(value.projectDir, ".gitignore"), "utf8");

		expect(result.subject).toEqual(subject);
		expect(TargetScaffoldReceiptSchema.parse(result.receipt)).toEqual(result.receipt);
		expect(result.receipt).toMatchObject({
			subject,
			subjectHash: hashValue(subject),
			targetGitSha: result.target.gitSha,
			actor: { kind: "human", id: "operator-1" },
			reason: "Reviewed the exact initial Target scaffold",
			scaffoldedAt: NOW,
		});
		expect(JSON.parse(readFileSync(result.receiptPath, "utf8"))).toEqual(result.receipt);
		expect(statSync(result.receiptPath).mode & 0o777).toBe(0o600);
		expect(git(value.projectDir, "rev-list", "--count", "HEAD")).toBe("1");
		expect(git(value.projectDir, "rev-parse", "HEAD")).toBe(result.target.gitSha);
		expect(git(value.projectDir, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
		expect(statSync(join(value.projectDir, "bin", "echo_json")).mode & 0o111).not.toBe(0);
		for (const pattern of subject.generated.localArtifactIgnores) {
			expect(ignoreFile).toContain(`${pattern}\n`);
		}
	});

	it("refuses a stale reviewed subject before mutating the project", () => {
		const value = fixture(true);
		const reviewed = describeTargetScaffold(value);
		writeFileSync(join(value.templateDir, "AGENTS.md"), "# Changed after review\n");

		expect(() => applyTargetScaffold({
			...options(value),
			expectedSubjectHash: hashValue(reviewed),
		}, { now: () => NOW })).toThrow(/subject changed after review/);
		expect(readdirSync(value.projectDir)).toEqual([".ahde"]);
		expect(readdirSync(value.stateRoot)).toEqual([]);
	});

	it("rolls all scaffold files back when receipt publication fails", () => {
		const value = fixture();
		writeFileSync(join(value.stateRoot, "existing-state.json"), "{}\n");

		expect(() => applyTargetScaffold(options(value), {
			now: () => NOW,
			writeReceipt: (_path, receipt) => {
				TargetScaffoldReceiptSchema.parse(receipt);
				throw new Error("simulated receipt failure");
			},
		})).toThrow(/simulated receipt failure/);

		expect(readdirSync(value.projectDir)).toEqual([".ahde"]);
		expect(readdirSync(value.stateRoot)).toEqual(["existing-state.json"]);
		expect(readFileSync(join(value.stateRoot, "existing-state.json"), "utf8")).toBe("{}\n");
		expect(existsSync(join(value.stateRoot, "target-scaffold.json"))).toBe(false);
	});

	it("rejects a non-empty destination without touching user files", () => {
		const value = fixture();
		const userFile = join(value.projectDir, "notes.txt");
		writeFileSync(userFile, "user-owned work\n");

		expect(() => describeTargetScaffold(value)).toThrow(/otherwise empty current directory; found notes\.txt/);
		expect(readFileSync(userFile, "utf8")).toBe("user-owned work\n");
		expect(readdirSync(value.stateRoot)).toEqual([]);
	});
});
