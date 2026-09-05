import type { GraderCheckCode } from "../provenance.js";

export type GraderCategory = "tool-selection" | "output-contract" | "answer-quality";

/** Preserve the stored record; a reader must never repair provenance in place. */
export class DiagnosisClassificationMismatch extends Error {
	constructor() {
		super("diagnosis does not match the verified evaluation evidence: the stored classification is incompatible; create a new evaluation and diagnosis without replacing the stored evidence");
		this.name = "DiagnosisClassificationMismatch";
	}
}

/** Exact grader families and legacy records use the same category in diagnosis and brief. */
const CHECK_CATEGORIES: Record<GraderCheckCode, GraderCategory> = {
	"required-tool": "tool-selection",
	"output-contains": "output-contract",
	"output-matches": "output-contract",
	"reference-exact": "output-contract",
	"no-secret": "output-contract",
	"semantic-rubric": "answer-quality",
	"reference-similarity": "answer-quality",
	"turn-budget": "output-contract",
	"world-state": "output-contract",
	"final-answer": "output-contract",
	"cites-source": "answer-quality",
};

export function categoryForGrader(grader: { type: string; checkCode?: GraderCheckCode }): GraderCategory {
	const known = grader.checkCode ? CHECK_CATEGORIES[grader.checkCode] : undefined;
	if (known) return known;
	if (grader.type === "tool_called") return "tool-selection";
	if (["output_contains", "output_matches", "exact", "no_secret"].includes(grader.type)) return "output-contract";
	return "answer-quality";
}
