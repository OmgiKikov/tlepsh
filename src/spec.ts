import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { hashValue } from "./provenance.js";
import { readJsonArtifact, writeJsonArtifact } from "./storage/artifacts.js";

const ProjectIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const SpecIdSchema = z.string().regex(/^spec-[0-9a-f]{64}$/);
const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const NonBlankSchema = z.string().min(1).refine((value) => value.trim().length > 0, "expected non-blank text");

export const AgentSpecSchema = z.strictObject({
	schemaVersion: z.literal(1),
	title: NonBlankSchema.max(160),
	purpose: NonBlankSchema.max(4_000),
	users: z.array(NonBlankSchema.max(500)).max(50),
	jobs: z.array(NonBlankSchema.max(500)).max(50),
	inputs: z.array(NonBlankSchema.max(500)).max(50),
	allowedActions: z.array(NonBlankSchema.max(500)).max(50),
	successCriteria: z.array(NonBlankSchema.max(500)).max(50),
	constraints: z.array(NonBlankSchema.max(500)).max(50),
	openQuestions: z.array(NonBlankSchema.max(500)).max(50),
});
export type AgentSpec = z.infer<typeof AgentSpecSchema>;

export const SpecSnapshotSchema = z.strictObject({
	schemaVersion: z.literal(1),
	id: SpecIdSchema,
	projectId: ProjectIdSchema,
	status: z.enum(["draft", "approved"]),
	spec: AgentSpecSchema,
	sourceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
	createdAt: z.iso.datetime({ offset: true }),
}).superRefine((snapshot, context) => {
	const identity = hashValue({
		schemaVersion: snapshot.schemaVersion,
		projectId: snapshot.projectId,
		status: snapshot.status,
		spec: snapshot.spec,
		sourceHash: snapshot.sourceHash,
	});
	const expected = `spec-${identity.slice("sha256:".length)}`;
	if (snapshot.id !== expected) {
		context.addIssue({ code: "custom", path: ["id"], message: "spec id does not match snapshot content" });
	}
});
export type SpecSnapshot = z.infer<typeof SpecSnapshotSchema>;

/** Exact, portable identity of an approved immutable specification snapshot. */
export const ApprovedSpecReferenceSchema = z.strictObject({
	projectId: ProjectIdSchema,
	specId: SpecIdSchema,
	specContentHash: Sha256Schema,
	snapshotHash: Sha256Schema,
});
export type ApprovedSpecReference = z.infer<typeof ApprovedSpecReferenceSchema>;

export interface ApprovedSpecInput {
	stateRoot: string;
	projectId: string;
	specId: string;
}

export interface LoadedApprovedSpec {
	reference: ApprovedSpecReference;
	snapshot: SpecSnapshot;
}

export interface SaveSpecSnapshotOptions {
	stateRoot: string;
	projectId: string;
	spec: AgentSpec;
	status: "draft" | "approved";
	sourceText?: string;
	now?: () => string;
}

function contained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function specsRoot(stateRoot: string, projectIdInput: string, create: boolean): string | null {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const root = resolve(stateRoot);
	if (!existsSync(root)) {
		if (!create) return null;
		mkdirSync(root, { recursive: true, mode: 0o700 });
	}
	if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
		throw new Error(`spec stateRoot must be a regular directory: ${root}`);
	}
	const canonicalRoot = realpathSync(root);
	let current = root;
	for (const segment of ["projects", projectId, "specs"]) {
		const next = join(current, segment);
		if (!existsSync(next)) {
			if (!create) return null;
			mkdirSync(next, { mode: 0o700 });
		}
		const entry = lstatSync(next);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(`spec state component must be a regular directory: ${next}`);
		}
		if (!contained(canonicalRoot, realpathSync(next))) throw new Error("spec state path escaped stateRoot");
		current = next;
	}
	return current;
}

function snapshotPath(stateRoot: string, projectId: string, specId: string): string {
	const id = SpecIdSchema.parse(specId);
	const root = specsRoot(stateRoot, projectId, false);
	if (!root) throw new Error(`project ${projectId} has no saved specifications`);
	return join(root, `${id}.json`);
}

export function saveSpecSnapshot(options: SaveSpecSnapshotOptions): SpecSnapshot {
	const projectId = ProjectIdSchema.parse(options.projectId);
	const spec = AgentSpecSchema.parse(options.spec);
	const sourceHash = options.sourceText === undefined ? null : hashValue(options.sourceText);
	const identity = hashValue({ schemaVersion: 1, projectId, status: options.status, spec, sourceHash });
	const id = `spec-${identity.slice("sha256:".length)}`;
	const root = specsRoot(options.stateRoot, projectId, true);
	if (!root) throw new Error("failed to create specification state directory");
	const path = join(root, `${id}.json`);
	if (existsSync(path)) return readJsonArtifact(path, SpecSnapshotSchema);
	const snapshot = SpecSnapshotSchema.parse({
		schemaVersion: 1,
		id,
		projectId,
		status: options.status,
		spec,
		sourceHash,
		createdAt: (options.now ?? (() => new Date().toISOString()))(),
	});
	try {
		writeJsonArtifact(path, SpecSnapshotSchema, snapshot, { immutable: true });
	} catch (error) {
		// A concurrent writer may have published the same content-addressed id.
		// Re-read and validate it; any mismatch or unreadable artifact still fails.
		if (!existsSync(path)) throw error;
		const existing = readJsonArtifact(path, SpecSnapshotSchema);
		if (existing.id !== snapshot.id || existing.projectId !== snapshot.projectId) throw error;
		return existing;
	}
	return snapshot;
}

export function loadSpecSnapshot(
	stateRoot: string,
	projectId: string,
	specId: string,
): SpecSnapshot {
	return readJsonArtifact(snapshotPath(stateRoot, projectId, specId), SpecSnapshotSchema);
}

/**
 * Resolve and validate the approved snapshot at the trust boundary. The id is
 * already derived from status + typed content; the two hashes make downstream
 * evidence independently comparable without copying filesystem paths.
 */
export function loadApprovedSpec(input: ApprovedSpecInput): LoadedApprovedSpec {
	const snapshot = loadSpecSnapshot(input.stateRoot, input.projectId, input.specId);
	if (snapshot.projectId !== input.projectId) throw new Error("approved spec project mismatch");
	if (snapshot.id !== input.specId) throw new Error("approved spec id mismatch");
	if (snapshot.status !== "approved") {
		throw new Error(`specification ${snapshot.id} is ${snapshot.status}; an approved snapshot is required`);
	}
	return {
		snapshot,
		reference: ApprovedSpecReferenceSchema.parse({
			projectId: snapshot.projectId,
			specId: snapshot.id,
			specContentHash: hashValue(snapshot.spec),
			snapshotHash: hashValue(snapshot),
		}),
	};
}

export function listSpecSnapshots(stateRoot: string, projectIdInput: string): SpecSnapshot[] {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const root = specsRoot(stateRoot, projectId, false);
	if (!root) return [];
	const snapshots: SpecSnapshot[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isFile() || !/^spec-[0-9a-f]{64}\.json$/.test(entry.name)) continue;
		const snapshot = readJsonArtifact(join(root, entry.name), SpecSnapshotSchema);
		if (snapshot.projectId !== projectId) throw new Error(`spec snapshot project mismatch: ${entry.name}`);
		snapshots.push(snapshot);
	}
	return snapshots.sort((a, b) =>
		a.createdAt === b.createdAt ? b.id.localeCompare(a.id) : b.createdAt.localeCompare(a.createdAt),
	);
}
