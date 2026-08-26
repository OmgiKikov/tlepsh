import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createCorpus,
	importCorpus,
	listCorpora,
	loadCorpus,
	type CorpusMetadata,
} from "../src/corpus.js";

const fixtureRoots: string[] = [];

function fixture(): { root: string; stateRoot: string } {
	const root = mkdtempSync(join(tmpdir(), "ahde-corpus-"));
	fixtureRoots.push(root);
	return { root, stateRoot: join(root, "state") };
}

function task(id: string, text = "ok") {
	return {
		id,
		input: `input-${id}`,
		graders: [{ type: "output_contains" as const, text }],
	};
}

function ref(stateRoot: string, metadata: CorpusMetadata) {
	return { stateRoot, projectId: metadata.projectId, corpusId: metadata.id };
}

function corpusDir(stateRoot: string, metadata: CorpusMetadata): string {
	return join(stateRoot, "projects", metadata.projectId, "corpora", metadata.id);
}

afterEach(() => {
	for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("corpus storage", () => {
	it("imports strict JSONL, canonicalizes tasks, and verifies the snapshot on load", () => {
		const { root, stateRoot } = fixture();
		const sourcePath = join(root, "source.jsonl");
		writeFileSync(sourcePath, `${JSON.stringify(task("a"))}\n\n${JSON.stringify(task("b"))}\n`, "utf8");

		const metadata = importCorpus({
			stateRoot,
			projectId: "project-1",
			name: "Development basket",
			visibility: "development",
			sourcePath,
		});
		const loaded = loadCorpus(ref(stateRoot, metadata));

		expect(metadata).toMatchObject({
			schemaVersion: 1,
			projectId: "project-1",
			name: "Development basket",
			visibility: "development",
			taskCount: 2,
			contentPath: "corpus.jsonl",
		});
		expect(metadata.id).toMatch(/^corpus-[0-9a-f]{64}$/);
		expect(metadata.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(loaded.tasks).toEqual([
			{ ...task("a"), graders: [{ type: "output_contains", text: "ok", caseSensitive: false }] },
			{ ...task("b"), graders: [{ type: "output_contains", text: "ok", caseSensitive: false }] },
		]);
		expect(existsSync(join(corpusDir(stateRoot, metadata), "metadata.json"))).toBe(true);
	});

	it("creates a sealed corpus from in-memory Studio tasks with private content", () => {
		const { stateRoot } = fixture();
		const metadata = createCorpus({
			stateRoot,
			projectId: "studio",
			name: "Synthetic holdout",
			visibility: "sealed",
			tasks: [task("secret")],
		});
		const contentPath = join(corpusDir(stateRoot, metadata), metadata.contentPath);

		expect(statSync(contentPath).mode & 0o777).toBe(0o600);
		expect(loadCorpus(ref(stateRoot, metadata)).tasks).toHaveLength(1);
	});

	it("rejects malformed JSONL, invalid UTF-8, schema-invalid tasks, and missing explicit graders", () => {
		const { root, stateRoot } = fixture();
		const sourcePath = join(root, "source.jsonl");
		const options = {
			stateRoot,
			projectId: "project",
			name: "bad",
			visibility: "development" as const,
			sourcePath,
		};

		writeFileSync(sourcePath, "not-json\n", "utf8");
		expect(() => importCorpus(options)).toThrow(/invalid JSONL at line 1/);

		writeFileSync(sourcePath, Buffer.from([0xff, 0xfe, 0xfd]));
		expect(() => importCorpus(options)).toThrow(/not valid UTF-8/);

		writeFileSync(sourcePath, `${JSON.stringify({ ...task("a"), extra: true })}\n`, "utf8");
		expect(() => importCorpus(options)).toThrow(/schema validation failed.*Unrecognized key/);

		writeFileSync(sourcePath, `${JSON.stringify({ id: "a", input: "x" })}\n`, "utf8");
		expect(() => importCorpus(options)).toThrow(/graders/);
	});

	it("rejects empty corpora and duplicate task ids", () => {
		const { root, stateRoot } = fixture();
		const sourcePath = join(root, "source.jsonl");
		writeFileSync(sourcePath, `${JSON.stringify(task("same"))}\n${JSON.stringify(task("same"))}\n`, "utf8");

		expect(() =>
			importCorpus({
				stateRoot,
				projectId: "project",
				name: "duplicates",
				visibility: "sealed",
				sourcePath,
			}),
		).toThrow(/duplicate task id "same"/);
		expect(() =>
			createCorpus({
				stateRoot,
				projectId: "project",
				name: "empty",
				visibility: "development",
				tasks: [],
			}),
		).toThrow(/at least one task/);
	});

	it("detects corrupt JSONL, count mismatch, and content hash mismatch", () => {
		const { stateRoot } = fixture();
		const corrupt = createCorpus({
			stateRoot,
			projectId: "project",
			name: "corrupt",
			visibility: "development",
			tasks: [task("a")],
		});
		writeFileSync(join(corpusDir(stateRoot, corrupt), corrupt.contentPath), "not-json\n", "utf8");
		expect(() => loadCorpus(ref(stateRoot, corrupt))).toThrow(/invalid JSONL at line 1/);

		const count = createCorpus({
			stateRoot,
			projectId: "project",
			name: "count",
			visibility: "development",
			tasks: [task("a"), task("b")],
		});
		writeFileSync(
			join(corpusDir(stateRoot, count), count.contentPath),
			`${JSON.stringify({ ...task("a"), graders: [{ type: "output_contains", text: "ok", caseSensitive: false }] })}\n`,
			"utf8",
		);
		expect(() => loadCorpus(ref(stateRoot, count))).toThrow(/task count mismatch/);

		const hash = createCorpus({
			stateRoot,
			projectId: "project",
			name: "hash",
			visibility: "development",
			tasks: [task("a")],
		});
		writeFileSync(
			join(corpusDir(stateRoot, hash), hash.contentPath),
			`${JSON.stringify({ ...task("a", "different"), graders: [{ type: "output_contains", text: "different", caseSensitive: false }] })}\n`,
			"utf8",
		);
		expect(() => loadCorpus(ref(stateRoot, hash))).toThrow(/hash mismatch/);
	});

	it("strictly validates metadata and rejects traversal in project and corpus references", () => {
		const { stateRoot } = fixture();
		expect(() =>
			createCorpus({
				stateRoot,
				projectId: "../escape",
				name: "x",
				visibility: "development",
				tasks: [task("a")],
			}),
		).toThrow(/invalid projectId.*traversal/);
		expect(() =>
			loadCorpus({ stateRoot, projectId: "project", corpusId: "../../escape" }),
		).toThrow(/invalid corpusId.*traversal/);

		const metadata = createCorpus({
			stateRoot,
			projectId: "project",
			name: "metadata",
			visibility: "development",
			tasks: [task("a")],
		});
		writeFileSync(
			join(corpusDir(stateRoot, metadata), "metadata.json"),
			`${JSON.stringify({ ...metadata, contentPath: "../secret.jsonl" })}\n`,
			"utf8",
		);
		expect(() => loadCorpus(ref(stateRoot, metadata))).toThrow(/contentPath/);

		const identity = createCorpus({
			stateRoot,
			projectId: "project",
			name: "identity",
			visibility: "development",
			tasks: [task("identity")],
		});
		writeFileSync(
			join(corpusDir(stateRoot, identity), "metadata.json"),
			`${JSON.stringify({ ...identity, name: "tampered identity" })}\n`,
			"utf8",
		);
		expect(() => loadCorpus(ref(stateRoot, identity))).toThrow(/id does not match its content identity/);
	});

	it("requires sealed content to remain mode 0600", () => {
		const { stateRoot } = fixture();
		const metadata = createCorpus({
			stateRoot,
			projectId: "project",
			name: "sealed",
			visibility: "sealed",
			tasks: [task("a")],
		});
		chmodSync(join(corpusDir(stateRoot, metadata), metadata.contentPath), 0o644);
		expect(() => loadCorpus(ref(stateRoot, metadata))).toThrow(/must have content mode 0600.*0644/);
	});

	it("lists metadata without opening or returning sealed content", () => {
		const { stateRoot } = fixture();
		const development = createCorpus({
			stateRoot,
			projectId: "project",
			name: "dev",
			visibility: "development",
			tasks: [task("dev")],
		});
		const sealed = createCorpus({
			stateRoot,
			projectId: "project",
			name: "sealed",
			visibility: "sealed",
			tasks: [task("sealed")],
		});
		// Corrupt and make the sealed content unreadable: listing must still use
		// metadata.json only.
		const sealedContent = join(corpusDir(stateRoot, sealed), sealed.contentPath);
		writeFileSync(sealedContent, "not-json\n", "utf8");
		chmodSync(sealedContent, 0o000);

		const listed = listCorpora({ stateRoot, projectId: "project" });
		expect(listed.map((item) => item.id).sort()).toEqual([development.id, sealed.id].sort());
		expect(listed.every((item) => !("tasks" in item))).toBe(true);
		expect(JSON.stringify(listed)).not.toContain("input-sealed");
	});

	it("uses a content-derived id and never overwrites an existing corpus", () => {
		const { stateRoot } = fixture();
		const options = {
			stateRoot,
			projectId: "project",
			name: "immutable",
			visibility: "development" as const,
			tasks: [task("a")],
		};
		const first = createCorpus(options);
		const dir = corpusDir(stateRoot, first);
		const metadataBefore = readFileSync(join(dir, "metadata.json"), "utf8");
		const contentBefore = readFileSync(join(dir, first.contentPath), "utf8");

		expect(() => createCorpus(options)).toThrow(/already exists.*cannot be overwritten/);
		expect(readFileSync(join(dir, "metadata.json"), "utf8")).toBe(metadataBefore);
		expect(readFileSync(join(dir, first.contentPath), "utf8")).toBe(contentBefore);
	});
});
