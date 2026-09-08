import { z } from "zod";
import { git, gitText, worktreeRoot } from "../git/commands.js";
import { MAX_DATA_DIRECTORIES, type CaseSource, type ResolvedTarget } from "../manifest.js";
import { GitShaSchema } from "../provenance.js";
import { KB_DATA_DECLARATION } from "../target/kb-tool.js";
import { sha256 } from "../util.js";
import { parseDataset, type ParsedDataset } from "./dataset-parse.js";
import { readDatasetSource } from "./dataset-source.js";
import { BUILDER_CORPUS_IMPORT_ROOT } from "./builder-corpus-import-contract.js";
import { readTargetFeedback } from "./target-feedback.js";
import { namedDirtyPaths, operatorDirtyPaths } from "./store-hygiene.js";

const KbRootPathSchema = z.string().max(200)
	.regex(/^data\/kb(?:\/[a-z0-9][a-z0-9._-]*)*$/, "KB roots must be safe directories under data/kb");

export const CorpusSourceBindingSchema = z.strictObject({
	algorithmId: z.literal("declared-kb-trees-v1"),
	targetId: z.string().max(100).regex(/^[a-z0-9][a-z0-9-]*$/),
	roots: z.array(z.strictObject({ path: KbRootPathSchema, treeSha: GitShaSchema }))
		.max(MAX_DATA_DIRECTORIES)
		.refine((roots) => roots.every((root, index) => index === 0 || roots[index - 1]!.path < root.path),
			"KB roots must be sorted and unique"),
});
export type CorpusSourceBinding = z.infer<typeof CorpusSourceBindingSchema>;

/**
 * The host supplies a Target resolved from its exact clean revision. Only Git
 * tree metadata is read: every committed byte and mode under each declared KB
 * root participates, without opening documents or preparing tools. No whole
 * commit SHA is stored, so evaluator-only commits do not change this binding.
 * With no declared KB roots, return an empty binding without any Git access;
 * this is source protection, not a general Target-readiness check.
 */
export function captureCorpusSourceBinding(target: ResolvedTarget): CorpusSourceBinding {
	const binding: CorpusSourceBinding = {
		algorithmId: "declared-kb-trees-v1",
		targetId: CorpusSourceBindingSchema.shape.targetId.parse(target.manifest.id),
		roots: [],
	};
	const paths = z.array(KbRootPathSchema).max(MAX_DATA_DIRECTORIES).parse(
		[...new Set(target.manifest.data.filter((path) =>
			path === KB_DATA_DECLARATION || path.startsWith(`${KB_DATA_DECLARATION}/`)))].sort(),
	);
	if (paths.length === 0) return binding;
	const repositoryDir = worktreeRoot(target.dir);
	const revision = GitShaSchema.parse(target.gitSha);
	const assertCurrent = (): void => {
		const dirty = operatorDirtyPaths(git(repositoryDir, [
			"--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=all",
		]).toString("utf8"));
		if (dirty.length > 0) throw new Error(`Corpus source Target has uncommitted changes: ${namedDirtyPaths(dirty)}`);
		if (gitText(repositoryDir, ["rev-parse", "--verify", "HEAD^{commit}"]) !== revision) {
			throw new Error("Corpus source Target changed since it was resolved; refresh the Target view.");
		}
	};
	assertCurrent();
	binding.roots = paths.map((path) => {
		// No recursive listing or blob reads: a tree ID covers its entire scope.
		const entry = git(repositoryDir, ["ls-tree", "-z", revision, "--", path]).toString("utf8");
		const tree = /^040000 tree ([0-9a-f]{40})\t([^\0]+)\0$/.exec(entry);
		if (!tree || tree[2] !== path) {
			throw new Error(`Corpus source KB root ${path} must be a committed directory tree, not a missing path, file or symlink.`);
		}
		return { path, treeSha: tree[1]! };
	});
	assertCurrent();
	return CorpusSourceBindingSchema.parse(binding);
}

/** How a case's source is named to a reader, and the source's own text when there is one. */
export interface CaseSourceReading {
	label: string;
	/** The cited text, or null when the host mints the source and there is nothing to quote. */
	text: string | null;
}

/** Enough of a document for a reader to judge whether the case is answerable from it. */
const MAX_CASE_SOURCE_TEXT_CHARS = 24_000;

function kbRoots(target: ResolvedTarget): string[] {
	return target.manifest.data.filter((path) =>
		path === KB_DATA_DECLARATION || path.startsWith(`${KB_DATA_DECLARATION}/`));
}

function rowText(dataset: ParsedDataset, row: number): string {
	const cells = dataset.rows[row]?.cells ?? {};
	return Object.entries(cells).map(([column, value]) => `${column}: ${value}`).join("\n");
}

/**
 * A case's citation, read from the bytes it actually names.
 *
 * The model writes `source` itself, so an unchecked citation is the one defect
 * the critic cannot catch: it would read an invented document, find the case
 * perfectly answerable from it, and call it valid. Every model-facing kind is
 * therefore resolved against the thing it claims — the KB blob at the Target's
 * own revision, the inbox file on disk, the mark in the feedback log — and a
 * mismatch names the field that is wrong.
 *
 * The reader is a closure because a draft cites a hundred sources and the Git
 * root, the inbox file and its parse are the same work every time.
 */
export function caseSourceReader(
	target: ResolvedTarget,
	projectDir: string,
): (source: CaseSource) => CaseSourceReading {
	let repository: { dir: string; revision: string } | null = null;
	const datasets = new Map<string, { sha256: string; parsed: ParsedDataset }>();
	const gitRepository = (): { dir: string; revision: string } => {
		repository ??= { dir: worktreeRoot(target.dir), revision: GitShaSchema.parse(target.gitSha) };
		return repository;
	};
	const dataset = (path: string): { sha256: string; parsed: ParsedDataset } => {
		const cached = datasets.get(path);
		if (cached) return cached;
		const file = readDatasetSource({ projectDir, sourcePath: path });
		const loaded = { sha256: file.sha256, parsed: parseDataset(file) };
		datasets.set(path, loaded);
		return loaded;
	};
	return (source) => {
		switch (source.kind) {
			case "spec":
				// The Spec is the one source the reader does not hold: its exact text
				// is the approved snapshot the caller already has.
				return { label: "the approved Spec", text: null };
			case "kb": {
				const roots = kbRoots(target);
				if (roots.length === 0) {
					throw new Error(`source.path ${source.path} cites data/kb, but the Target declares no data/kb root`);
				}
				if (!roots.some((root) => source.path.startsWith(`${root}/`))) {
					throw new Error(
						`source.path ${source.path} is not under a declared data/kb root (${roots.join(", ")})`,
					);
				}
				const { dir, revision } = gitRepository();
				let blob: Buffer;
				try {
					blob = git(dir, ["show", `${revision}:${source.path}`]);
				} catch {
					throw new Error(`source.path ${source.path} does not exist in the Target at revision ${revision}`);
				}
				const digest = sha256(blob);
				if (digest !== source.sha256) {
					throw new Error(
						`source.sha256 for ${source.path} is ${source.sha256}, but the document at revision ${revision} is ${digest}`,
					);
				}
				return { label: source.path, text: blob.toString("utf8").slice(0, MAX_CASE_SOURCE_TEXT_CHARS) };
			}
			case "import": {
				// The schema calls this "the imports/ file", and both spellings reach
				// here from the model; only the inbox is ever read either way.
				const path = source.path.startsWith(`${BUILDER_CORPUS_IMPORT_ROOT}/`)
					? source.path
					: `${BUILDER_CORPUS_IMPORT_ROOT}/${source.path}`;
				let loaded: { sha256: string; parsed: ParsedDataset };
				try {
					loaded = dataset(path);
				} catch (error) {
					throw new Error(`source.path ${path} could not be read: ${error instanceof Error ? error.message : String(error)}`);
				}
				if (loaded.sha256 !== source.sha256) {
					throw new Error(`source.sha256 for ${path} is ${source.sha256}, but the file on disk is ${loaded.sha256}`);
				}
				if (source.row >= loaded.parsed.rows.length) {
					throw new Error(`source.row ${source.row} is past the ${loaded.parsed.rows.length} row(s) of ${path}`);
				}
				return {
					label: `${path} row ${source.row}`,
					text: rowText(loaded.parsed, source.row).slice(0, MAX_CASE_SOURCE_TEXT_CHARS),
				};
			}
			case "feedback": {
				const mark = readTargetFeedback(projectDir).marks.find((entry) => entry.at === source.at);
				if (!mark) throw new Error(`source.at ${source.at} names no mark in imports/feedback.jsonl`);
				const dialogue = mark.messages.map((message) => `${message.role}: ${message.content}`).join("\n");
				return {
					label: `imports/feedback.jsonl mark ${source.at} (${mark.verdict})`,
					text: `${mark.note ? `note: ${mark.note}\n` : ""}${dialogue}`.slice(0, MAX_CASE_SOURCE_TEXT_CHARS),
				};
			}
			case "production":
				return { label: `production trace ${source.traceId}`, text: null };
			case "generated":
				return { label: "a generated case", text: null };
		}
	};
}

/**
 * The same reading, used only for its refusals: the draft path checks a
 * citation and throws away the text. `production` and `generated` are minted by
 * the host, so a draft that carries one has not been through the host at all.
 */
export function verifyCaseSource(
	target: ResolvedTarget,
	projectDir: string,
): (source: CaseSource) => void {
	const read = caseSourceReader(target, projectDir);
	return (source) => {
		if (source.kind === "production" || source.kind === "generated") {
			throw new Error(`source.kind ${source.kind} is host-minted and cannot be written by a Builder`);
		}
		read(source);
	};
}
