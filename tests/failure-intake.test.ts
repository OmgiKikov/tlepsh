import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	importProductionFailure,
	loadProductionFailure,
} from "../src/application/failure-intake.js";
import { hashFile } from "../src/provenance.js";

const roots: string[] = [];

function fixture(): { projectDir: string; stateRoot: string } {
	const projectDir = mkdtempSync(join(tmpdir(), "ahde-failure-intake-"));
	roots.push(projectDir);
	mkdirSync(join(projectDir, "imports"));
	return { projectDir, stateRoot: join(projectDir, ".ahde") };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const importedAgainst = { id: "support-agent", gitSha: "a".repeat(40) };

describe("production failure intake", () => {
	it("imports one Pi trace as a bounded redacted record with reported-only tool evidence", () => {
		const { projectDir, stateRoot } = fixture();
		const source = [
			{
				type: "message",
				message: { role: "user", content: "I am Alice Example; why is my account blocked?" },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{
						type: "toolCall",
						id: "call-1",
						name: "account_lookup",
						arguments: { customer: "Alice Example", api_key: "sk-this-must-not-survive" },
					}],
				},
			},
			{
				type: "message",
				message: {
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "account_lookup",
					content: "api_key='sk-this-must-not-survive'",
					isError: false,
				},
			},
			{
				type: "message",
				message: { role: "assistant", content: "Alice Example, your api_key='sk-this-must-not-survive' is fine." },
			},
		].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
		writeFileSync(join(projectDir, "imports", "incident.jsonl"), source);

		const first = importProductionFailure({
			projectDir,
			stateRoot,
			sourcePath: "imports/incident.jsonl",
			sourceKind: "real",
			targetClaim: { id: "production-alias", gitSha: "release-42" },
			exactRedactionValues: ["Alice Example", "Alice Example"],
		}, {
			now: () => "2026-09-04T12:00:00.000Z",
			resolveImportedAgainst: () => importedAgainst,
		});

		expect(first.failure).toMatchObject({
			schemaVersion: 1,
			kind: "production-failure",
			projectId: "support-agent",
			source: {
				kind: "real",
				path: "imports/incident.jsonl",
				sha256: hashFile(source),
				format: "pi-session-jsonl",
			},
			importedAgainst,
			targetClaim: { id: "production-alias", gitSha: "release-42" },
			redaction: {
				algorithm: "trace-credentials+host-exact-values-v1",
				hostExactValueCount: 1,
			},
			toolEvents: [
				{ type: "call", name: "account_lookup", evidence: "reported" },
				{ type: "result", name: "account_lookup", isError: false, evidence: "reported" },
			],
			omittedToolEventCount: 0,
			importedAt: "2026-09-04T12:00:00.000Z",
		});
		expect(first.failure.id).toMatch(/^failure-[0-9a-f]{64}$/);
		expect(JSON.stringify(first.failure)).not.toContain("Alice Example");
		expect(JSON.stringify(first.failure)).not.toContain("sk-this-must-not-survive");
		expect(first.failure.messages).toEqual([
			{ role: "user", content: "I am [REDACTED]; why is my account blocked?" },
			{ role: "assistant", content: "[REDACTED], your api_key='[REDACTED]' is fine." },
		]);
		expect("piiSafe" in first.failure.redaction).toBe(false);
		expect(first.provenance).toMatchObject({
			schemaVersion: 1,
			failureId: first.failure.id,
			source: { path: "imports/incident.jsonl", sha256: hashFile(source) },
			importedAgainst,
			targetClaim: { id: "production-alias", gitSha: "release-42" },
			toolEvidence: { authority: "reported", eventCount: 2, omittedCount: 0 },
		});

		const repeated = importProductionFailure({
			projectDir,
			stateRoot,
			sourcePath: "imports/incident.jsonl",
			sourceKind: "real",
			targetClaim: { id: "production-alias", gitSha: "release-42" },
			exactRedactionValues: ["Alice Example"],
		}, {
			now: () => "2026-09-04T13:00:00.000Z",
			resolveImportedAgainst: () => importedAgainst,
		});
		expect(repeated).toEqual(first);
		expect(loadProductionFailure(stateRoot, "support-agent", first.failure.id)).toEqual(first.failure);
	});

	it("imports a single synthetic chat export and never upgrades its tool claims", () => {
		const { projectDir, stateRoot } = fixture();
		const source = JSON.stringify({
			messages: [
				{ role: "user", content: "Find order 42" },
				{
					role: "assistant",
					content: "",
					tool_calls: [{
						id: "call-42",
						type: "function",
						function: { name: "orders_get", arguments: "{\"id\":42}" },
					}],
				},
				{ role: "tool", name: "orders_get", tool_call_id: "call-42", content: "not found" },
				{ role: "assistant", content: "The order exists." },
			],
		});
		writeFileSync(join(projectDir, "imports", "synthetic.json"), source);

		const result = importProductionFailure({
			projectDir,
			stateRoot,
			sourcePath: "imports/synthetic.json",
			sourceKind: "synthetic",
		}, { resolveImportedAgainst: () => importedAgainst });

		expect(result.failure.source.format).toBe("chat-export");
		expect(result.failure.source.kind).toBe("synthetic");
		expect(result.failure.targetClaim).toBeNull();
		expect(result.failure.messages).toEqual([
			{ role: "user", content: "Find order 42" },
			{ role: "assistant", content: "The order exists." },
		]);
		expect(result.failure.toolEvents).toEqual([
			{ type: "call", name: "orders_get", evidence: "reported" },
			{ type: "result", name: "orders_get", isError: false, evidence: "reported" },
		]);
	});

	it("refuses a source containing more than one conversation", () => {
		const { projectDir, stateRoot } = fixture();
		writeFileSync(join(projectDir, "imports", "batch.json"), JSON.stringify([
			{ messages: [{ role: "user", content: "A" }, { role: "assistant", content: "bad A" }] },
			{ messages: [{ role: "user", content: "B" }, { role: "assistant", content: "bad B" }] },
		]));

		expect(() => importProductionFailure({
			projectDir,
			stateRoot,
			sourcePath: "imports/batch.json",
			sourceKind: "real",
		}, { resolveImportedAgainst: () => importedAgainst })).toThrow(/exactly one trace/);
	});
});
