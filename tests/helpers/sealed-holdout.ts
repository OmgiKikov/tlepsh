import { SEALED_GATE_POLICY } from "../../src/domain/comparison-gate.js";
import type { createCorpus } from "../../src/corpus.js";

type CorpusTaskInput = Parameters<typeof createCorpus>[0]["tasks"][number];

/**
 * A sealed holdout large enough for a sealed verdict: the gate needs at
 * least `SEALED_GATE_POLICY.minTasks` tasks and `minRepetitions` repetitions.
 * Inputs share a prefix so scripted mock models keep matching them.
 */
export function sealedHoldoutTasks(
	input: string,
	graderText = "READY",
	count = SEALED_GATE_POLICY.minTasks,
): CorpusTaskInput[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `holdout-${index + 1}`,
		input: `${input} ${index + 1}`,
		graders: [{ type: "output_contains" as const, text: graderText }],
	}));
}

export const SEALED_VERIFICATION_REPETITIONS = SEALED_GATE_POLICY.minRepetitions;
