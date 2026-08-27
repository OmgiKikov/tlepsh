import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { CandidateRecord } from "../domain/candidate.js";
import { hashValue } from "../provenance.js";
import { readJsonArtifact, writeJsonArtifact } from "../storage/artifacts.js";
import { workbenchStateDirectory } from "./focus.js";

const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const NonBlankSchema = z.string().min(1).refine((value) => value.trim().length > 0);

export const CandidateAbandonmentReceiptSchema = z.strictObject({
	schemaVersion: z.literal(1),
	projectId: IdSchema,
	candidateId: IdSchema,
	candidateHash: HashSchema,
	interruptedStatus: z.enum(["proposed", "built", "validated"]),
	actor: z.strictObject({ kind: z.literal("human"), id: NonBlankSchema.max(256) }),
	reason: NonBlankSchema.max(4_000),
	abandonedAt: z.iso.datetime({ offset: true }),
	receiptHash: HashSchema,
}).superRefine((receipt, context) => {
	const { receiptHash: _receiptHash, ...identity } = receipt;
	if (receipt.receiptHash !== hashValue(identity)) {
		context.addIssue({
			code: "custom",
			path: ["receiptHash"],
			message: "receipt hash does not match abandonment evidence",
		});
	}
});
export type CandidateAbandonmentReceipt = z.infer<typeof CandidateAbandonmentReceiptSchema>;

function receiptPath(stateRoot: string, projectId: string, candidateId: string, create: boolean): string | null {
	const root = workbenchStateDirectory(stateRoot, IdSchema.parse(projectId), create);
	if (!root) return null;
	const directory = join(root, "candidate-abandonments");
	if (!existsSync(directory)) {
		if (!create) return null;
		mkdirSync(directory, { mode: 0o700 });
	}
	const entry = lstatSync(directory);
	if (!entry.isDirectory() || entry.isSymbolicLink()) {
		throw new Error("Workbench candidate abandonment storage must be a regular non-symlink directory");
	}
	return join(directory, `${IdSchema.parse(candidateId)}.json`);
}

export function loadCandidateAbandonment(
	stateRoot: string,
	projectId: string,
	candidateId: string,
): CandidateAbandonmentReceipt | null {
	const path = receiptPath(stateRoot, projectId, candidateId, false);
	if (!path || !existsSync(path)) return null;
	return readJsonArtifact(path, CandidateAbandonmentReceiptSchema);
}

export function recordCandidateAbandonment(input: {
	stateRoot: string;
	projectId: string;
	candidate: CandidateRecord;
	interruptedStatus: "proposed" | "built" | "validated";
	actor: { kind: "human"; id: string };
	reason: string;
	now: () => string;
}): CandidateAbandonmentReceipt {
	if (input.candidate.projectId !== input.projectId) {
		throw new Error("candidate belongs to a different Workbench project");
	}
	const path = receiptPath(input.stateRoot, input.projectId, input.candidate.candidateId, true)!;
	if (existsSync(path)) throw new Error("interrupted candidate already has an abandonment receipt");
	const identity = {
		schemaVersion: 1 as const,
		projectId: input.projectId,
		candidateId: input.candidate.candidateId,
		candidateHash: hashValue(input.candidate),
		interruptedStatus: input.interruptedStatus,
		actor: input.actor,
		reason: input.reason,
		abandonedAt: input.now(),
	};
	const receipt = CandidateAbandonmentReceiptSchema.parse({
		...identity,
		receiptHash: hashValue(identity),
	});
	writeJsonArtifact(path, CandidateAbandonmentReceiptSchema, receipt, { immutable: true });
	return receipt;
}
