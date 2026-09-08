import { chmodSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CorpusRef } from "../../src/corpus.js";

export const CORPUS_INVENTORY_FAULTS = [
	"corrupt metadata",
	"missing metadata",
	"broken store link",
	"non-directory corpus",
	...(process.platform !== "win32" && process.getuid?.() !== 0
		? ["unreadable metadata", "unreadable inventory", "unsearchable project"] as const
		: []),
] as const;

/** Damage real storage, not the lookup mock; restore permissions before fixture cleanup. */
export function damageCorpusInventory(ref: CorpusRef, fault: typeof CORPUS_INVENTORY_FAULTS[number]): () => void {
	const project = join(ref.stateRoot, "projects", ref.projectId);
	const inventory = join(project, "corpora");
	const corpus = join(inventory, ref.corpusId);
	const metadata = join(corpus, "metadata.json");
	if (fault === "corrupt metadata") writeFileSync(metadata, "{broken-json\n");
	else if (fault === "missing metadata") rmSync(metadata);
	else if (fault === "broken store link") {
		renameSync(inventory, `${inventory}.saved`);
		symlinkSync(join(project, "missing-corpora"), inventory);
	} else if (fault === "non-directory corpus") {
		renameSync(corpus, `${corpus}.saved`);
		writeFileSync(corpus, "not a corpus directory\n");
	} else {
		const path = fault === "unreadable metadata" ? metadata
			: fault === "unreadable inventory" ? inventory : project;
		const mode = statSync(path).mode & 0o777;
		chmodSync(path, 0);
		return () => chmodSync(path, mode);
	}
	return () => {};
}
