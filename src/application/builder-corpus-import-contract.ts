import { isAbsolute } from "node:path";
import { z } from "zod";
import { HashSchema } from "../provenance.js";

export const BUILDER_CORPUS_IMPORT_ROOT = "imports";
export const MAX_BUILDER_CORPUS_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_BUILDER_CORPUS_IMPORT_TASKS = 100;

/**
 * Builder Pi can read corpus input only from this explicit project-local inbox.
 * Everything outside `imports/` remains outside the model-facing read surface.
 */
export const BuilderCorpusImportSourcePathSchema = z.string().min(1).max(4_096).superRefine((value, context) => {
	if (
		value !== value.trim() ||
		isAbsolute(value) ||
		value.includes("\\") ||
		value.includes("\0") ||
		value.includes("\r") ||
		value.includes("\n")
	) {
		context.addIssue({ code: "custom", message: "sourcePath must be a normalized project-relative path" });
		return;
	}
	const segments = value.split("/");
	if (segments[0] !== BUILDER_CORPUS_IMPORT_ROOT || segments.length < 2) {
		context.addIssue({
			code: "custom",
			message: `sourcePath must be inside the ${BUILDER_CORPUS_IMPORT_ROOT}/ Builder inbox`,
		});
	}
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === ".." || segment.startsWith("."))) {
		context.addIssue({ code: "custom", message: "sourcePath contains a forbidden path segment" });
	}
	if (!value.endsWith(".jsonl")) {
		context.addIssue({ code: "custom", message: "sourcePath must name a .jsonl file" });
	}
});

export const BuilderCorpusImportSourceSchema = z.strictObject({
	path: BuilderCorpusImportSourcePathSchema,
	sha256: HashSchema,
	bytes: z.number().int().min(1).max(MAX_BUILDER_CORPUS_IMPORT_BYTES),
	taskCount: z.number().int().min(1).max(MAX_BUILDER_CORPUS_IMPORT_TASKS),
});
export type BuilderCorpusImportSource = z.infer<typeof BuilderCorpusImportSourceSchema>;
