import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSpecSnapshots, loadSpecSnapshot, saveSpecSnapshot, type AgentSpec } from "../src/spec.js";

const roots: string[] = [];
const spec: AgentSpec = {
	schemaVersion: 1,
	title: "Ticket triage",
	purpose: "Classify support tickets and prepare a bounded response.",
	users: ["support operator"],
	jobs: ["classify a ticket"],
	inputs: ["ticket text"],
	allowedActions: ["read the local policy"],
	successCriteria: ["classification matches the rubric"],
	constraints: ["no network"],
	openQuestions: ["Which ticket taxonomy is authoritative?"],
};

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("specification snapshots", () => {
	it("publishes immutable, idempotent private snapshots and lists newest first", () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "ahde-spec-"));
		roots.push(stateRoot);
		const first = saveSpecSnapshot({
			stateRoot,
			projectId: "project-1",
			spec,
			status: "draft",
			sourceText: "rough idea",
			now: () => "2026-08-26T10:00:00.000Z",
		});
		const duplicate = saveSpecSnapshot({
			stateRoot,
			projectId: "project-1",
			spec,
			status: "draft",
			sourceText: "rough idea",
			now: () => "2026-08-26T11:00:00.000Z",
		});
		const approved = saveSpecSnapshot({
			stateRoot,
			projectId: "project-1",
			spec,
			status: "approved",
			sourceText: "rough idea",
			now: () => "2026-08-26T12:00:00.000Z",
		});
		expect(duplicate).toEqual(first);
		expect(approved.id).not.toBe(first.id);
		expect(listSpecSnapshots(stateRoot, "project-1").map((value) => value.id)).toEqual([
			approved.id,
			first.id,
		]);
		expect(loadSpecSnapshot(stateRoot, "project-1", first.id)).toEqual(first);
		const path = join(stateRoot, "projects", "project-1", "specs", `${first.id}.json`);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("rejects traversal project and snapshot identifiers", () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "ahde-spec-"));
		roots.push(stateRoot);
		expect(() => saveSpecSnapshot({ stateRoot, projectId: "../escape", spec, status: "draft" })).toThrow();
		expect(() => loadSpecSnapshot(stateRoot, "project-1", "../escape")).toThrow();
	});

	it("rejects a snapshot whose content no longer matches its content-addressed id", () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "ahde-spec-"));
		roots.push(stateRoot);
		const saved = saveSpecSnapshot({ stateRoot, projectId: "project-1", spec, status: "approved" });
		const path = join(stateRoot, "projects", "project-1", "specs", `${saved.id}.json`);
		writeFileSync(path, `${JSON.stringify({ ...saved, spec: { ...saved.spec, purpose: "tampered" } })}\n`);
		expect(() => loadSpecSnapshot(stateRoot, "project-1", saved.id)).toThrow(/id does not match snapshot content/);
	});
});
