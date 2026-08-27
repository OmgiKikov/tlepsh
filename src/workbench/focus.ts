import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";
import { WorkbenchSelectionKindSchema, type WorkbenchSelectionKind } from "./types.js";

const ProjectIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const FingerprintSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const WorkbenchFocusEntrySchema = z.strictObject({
	id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/),
	hash: FingerprintSchema,
});
export type WorkbenchFocusEntry = z.infer<typeof WorkbenchFocusEntrySchema>;

export const WorkbenchFocusSchema = z.strictObject({
	schemaVersion: z.literal(1),
	projectId: ProjectIdSchema,
	selections: z.partialRecord(WorkbenchSelectionKindSchema, WorkbenchFocusEntrySchema),
	updatedAt: z.iso.datetime({ offset: true }),
});
export type WorkbenchFocus = z.infer<typeof WorkbenchFocusSchema>;

function contained(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function workbenchStateDirectory(stateRootInput: string, projectIdInput: string, create: boolean): string | null {
	const stateRoot = resolve(stateRootInput);
	const projectId = ProjectIdSchema.parse(projectIdInput);
	if (!existsSync(stateRoot)) {
		if (!create) return null;
		mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	}
	const rootEntry = lstatSync(stateRoot);
	if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
		throw new Error(`Workbench stateRoot must be a regular non-symlink directory: ${stateRoot}`);
	}
	const canonicalRoot = realpathSync(stateRoot);
	let current = stateRoot;
	for (const segment of ["projects", projectId, "workbench"]) {
		const next = join(current, segment);
		if (!existsSync(next)) {
			if (!create) return null;
			mkdirSync(next, { mode: 0o700 });
		}
		const entry = lstatSync(next);
		if (!entry.isDirectory() || entry.isSymbolicLink()) {
			throw new Error(`Workbench state component must be a regular non-symlink directory: ${next}`);
		}
		if (!contained(canonicalRoot, realpathSync(next))) throw new Error("Workbench state path escaped stateRoot");
		current = next;
	}
	return current;
}

function focusPath(stateRoot: string, projectId: string, create: boolean): string | null {
	const directory = workbenchStateDirectory(stateRoot, projectId, create);
	return directory ? join(directory, "focus.json") : null;
}

export function emptyWorkbenchFocus(projectIdInput: string, now: () => string): WorkbenchFocus {
	return WorkbenchFocusSchema.parse({
		schemaVersion: 1,
		projectId: ProjectIdSchema.parse(projectIdInput),
		selections: {},
		updatedAt: now(),
	});
}

export function loadWorkbenchFocus(
	stateRoot: string,
	projectIdInput: string,
	now: () => string = () => new Date().toISOString(),
): WorkbenchFocus {
	const projectId = ProjectIdSchema.parse(projectIdInput);
	const path = focusPath(stateRoot, projectId, false);
	if (!path || !existsSync(path)) return emptyWorkbenchFocus(projectId, now);
	const entry = lstatSync(path);
	if (!entry.isFile() || entry.isSymbolicLink()) {
		throw new Error(`Workbench focus must be a regular non-symlink file: ${path}`);
	}
	const focus = readJsonArtifact(path, WorkbenchFocusSchema, { maxBytes: 128 * 1024 });
	if (focus.projectId !== projectId) throw new Error("Workbench focus belongs to another project");
	return focus;
}

export function saveWorkbenchFocus(stateRoot: string, focusInput: WorkbenchFocus): WorkbenchFocus {
	const focus = WorkbenchFocusSchema.parse(focusInput);
	const path = focusPath(stateRoot, focus.projectId, true);
	if (!path) throw new Error("failed to create Workbench focus directory");
	if (existsSync(path)) {
		const entry = lstatSync(path);
		if (!entry.isFile() || entry.isSymbolicLink()) {
			throw new Error(`Workbench focus must be a regular non-symlink file: ${path}`);
		}
	}
	writeJsonArtifact(path, WorkbenchFocusSchema, focus);
	return focus;
}

const CLEAR_DOWNSTREAM: Record<WorkbenchSelectionKind, readonly WorkbenchSelectionKind[]> = {
	"spec-draft": ["approved-spec", "corpus-draft", "development-corpus", "eval-run", "proposal", "candidate"],
	"approved-spec": ["spec-draft", "corpus-draft", "development-corpus", "eval-run", "proposal", "candidate"],
	"corpus-draft": ["development-corpus", "eval-run", "proposal", "candidate"],
	"development-corpus": ["corpus-draft", "eval-run", "proposal", "candidate"],
	"eval-run": ["proposal", "candidate"],
	proposal: ["candidate"],
	candidate: [],
};

export function selectWorkbenchFocus(
	focus: WorkbenchFocus,
	kind: WorkbenchSelectionKind,
	entry: WorkbenchFocusEntry,
	now: () => string = () => new Date().toISOString(),
): WorkbenchFocus {
	const selections = { ...focus.selections, [kind]: WorkbenchFocusEntrySchema.parse(entry) };
	for (const downstream of CLEAR_DOWNSTREAM[kind]) delete selections[downstream];
	return WorkbenchFocusSchema.parse({ ...focus, selections, updatedAt: now() });
}
