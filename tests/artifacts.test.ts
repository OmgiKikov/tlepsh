import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	ArtifactError,
	readJsonArtifact,
	readJsonlArtifact,
	writeJsonArtifact,
} from "../src/storage/artifacts.js";

const dirs: string[] = [];

function fixtureDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ahde-artifacts-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("JSON artifacts", () => {
	it("round-trips through a Zod codec and leaves only the published file", () => {
		const codec = z.codec(
			z.strictObject({ id: z.string(), createdAt: z.iso.datetime() }),
			z.strictObject({ id: z.string(), createdAt: z.date() }),
			{
				decode: (wire) => ({ ...wire, createdAt: new Date(wire.createdAt) }),
				encode: (value) => ({ ...value, createdAt: value.createdAt.toISOString() }),
			},
		);
		const dir = fixtureDir();
		const path = join(dir, "nested", "run.json");
		const value = { id: "run_1", createdAt: new Date("2026-08-26T10:20:30.000Z") };

		writeJsonArtifact(path, codec, value);

		expect(readJsonArtifact(path, codec)).toEqual(value);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			id: "run_1",
			createdAt: "2026-08-26T10:20:30.000Z",
		});
		expect(readdirSync(join(dir, "nested"))).toEqual(["run.json"]);
	});

	it("validates before writing and does not publish invalid data", () => {
		const dir = fixtureDir();
		const path = join(dir, "run.json");
		const codec = z.strictObject({ id: z.string() });

		expect(() => writeJsonArtifact(path, codec, { id: 42 } as never)).toThrow(/schema validation failed.*\$\.id/);
		expect(existsSync(path)).toBe(false);
	});

	it("refuses to replace an immutable artifact", () => {
		const dir = fixtureDir();
		const path = join(dir, "run.json");
		const codec = z.strictObject({ id: z.string() });
		writeJsonArtifact(path, codec, { id: "first" }, { immutable: true });

		expect(() => writeJsonArtifact(path, codec, { id: "second" }, { immutable: true })).toThrow(
			/immutable write refused.*already exists/,
		);
		expect(readJsonArtifact(path, codec)).toEqual({ id: "first" });
		expect(readdirSync(dir)).toEqual(["run.json"]);
	});

	it("distinguishes malformed JSON from schema-invalid JSON", () => {
		const dir = fixtureDir();
		const malformed = join(dir, "malformed.json");
		const invalid = join(dir, "invalid.json");
		const codec = z.strictObject({ id: z.string() });
		writeFileSync(malformed, '{"id":', "utf8");
		writeFileSync(invalid, '{"id":42}', "utf8");

		expect(() => readJsonArtifact(malformed, codec)).toThrow(/malformed\.json.*invalid JSON/);
		expect(() => readJsonArtifact(invalid, codec)).toThrow(/invalid\.json.*schema validation failed.*\$\.id/);
	});

	it("bounds JSON before parsing, including with the default limit", () => {
		const dir = fixtureDir();
		const small = join(dir, "small.json");
		const oversized = join(dir, "oversized.json");
		const codec = z.strictObject({ id: z.string() });
		writeFileSync(small, '{"id":"too long for this bound"}', "utf8");
		writeFileSync(oversized, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));

		expect(() => readJsonArtifact(small, codec, { maxBytes: 8 })).toThrow(/JSON exceeds maxBytes=8/);
		expect(() => readJsonArtifact(oversized, codec)).toThrow(/JSON exceeds maxBytes=16777216/);
		expect(() => readJsonArtifact(small, codec, { maxBytes: 0 })).toThrow(/positive safe integer/);
	});

	it("rejects symlinked and non-regular JSON artifacts", () => {
		const dir = fixtureDir();
		const target = join(dir, "target.json");
		const link = join(dir, "link.json");
		const codec = z.strictObject({ id: z.string() });
		writeFileSync(target, '{"id":"target"}', "utf8");
		symlinkSync(target, link);

		expect(() => readJsonArtifact(link, codec)).toThrow(/regular non-symlink file/);
		expect(() => readJsonArtifact(dir, codec)).toThrow(/regular non-symlink file/);
	});
});

describe("JSONL artifacts", () => {
	const codec = z.strictObject({ id: z.string(), score: z.number() });

	it("decodes records and ignores blank lines without losing physical line numbers", () => {
		const dir = fixtureDir();
		const path = join(dir, "records.jsonl");
		writeFileSync(path, '{"id":"a","score":1}\n\n{"id":"b","score":2}\n', "utf8");

		expect(readJsonlArtifact(path, codec)).toEqual([
			{ id: "a", score: 1 },
			{ id: "b", score: 2 },
		]);
	});

	it("reports the exact corrupt JSONL line instead of skipping it", () => {
		const dir = fixtureDir();
		const path = join(dir, "records.jsonl");
		writeFileSync(path, '{"id":"a","score":1}\nnot-json\n{"id":"b","score":2}\n', "utf8");

		expect(() => readJsonlArtifact(path, codec)).toThrow(/records\.jsonl.*invalid JSONL at line 2/);
	});

	it("reports schema failures with their JSONL line and field path", () => {
		const dir = fixtureDir();
		const path = join(dir, "records.jsonl");
		writeFileSync(path, '{"id":"a","score":1}\n{"id":"b","score":"bad"}\n', "utf8");

		expect(() => readJsonlArtifact(path, codec)).toThrow(
			/schema validation failed at JSONL line 2.*\$\.score/,
		);
	});

	it("enforces byte and record bounds", () => {
		const dir = fixtureDir();
		const path = join(dir, "records.jsonl");
		writeFileSync(path, '{"id":"a","score":1}\n{"id":"b","score":2}\n', "utf8");

		expect(() => readJsonlArtifact(path, codec, { maxBytes: 8 })).toThrow(/maxBytes=8/);
		expect(() => readJsonlArtifact(path, codec, { maxRecords: 1 })).toThrow(/maxRecords=1 at line 2/);
	});

	it("uses a stable error type with the resolved artifact path", () => {
		const dir = fixtureDir();
		const path = join(dir, "missing.jsonl");

		try {
			readJsonlArtifact(path, codec);
			expect.fail("expected read to fail");
		} catch (error) {
			expect(error).toBeInstanceOf(ArtifactError);
			expect((error as ArtifactError).artifactPath).toBe(path);
			expect((error as Error).message).toMatch(/missing\.jsonl.*read failed/);
		}
	});
});
