import { afterEach, describe, expect, it } from "vitest";
import { nextStep } from "../src/builder/render/stage.js";
import { setLanguage } from "../src/i18n.js";
import { diagnosisReadingOf, workbenchNext } from "../src/workbench/next-actions.js";
import type { WorkbenchDiagnosisReading, WorkbenchView } from "../src/workbench/types.js";

afterEach(() => setLanguage("en"));

const counts: WorkbenchView["counts"] = {
	specDrafts: 0, approvedSpecs: 1, corpusDrafts: 1, developmentCorpora: 1, sealedCorpora: 0,
	developmentEvals: 1, openProposals: 0, candidates: 0, calibrations: 0,
};

function brief(overrides: Partial<{ status: "healthy" | "actionable" | "inconclusive"; proposalEligible: boolean }> = {}) {
	return { evalRunId: "erun_1", status: "actionable" as const, proposalEligible: false, ...overrides };
}

/** Live session 10, as the view now reads it: a diagnosis with nothing proposable. */
function authoring(diagnosis?: WorkbenchDiagnosisReading, workshop?: WorkbenchView["workshop"]) {
	return {
		stage: "improvement-authoring" as const,
		headline: "Use the diagnosis to improve the harness in a workshop or with a structured proposal.",
		blockers: [],
		counts,
		target: { status: "ready" as const, id: "agent", gitSha: "f".repeat(40), model: null },
		...(diagnosis ? { diagnosis } : {}),
		...(workshop ? { workshop } : {}),
	};
}

const kinds = (entries: readonly { kind: string }[]) => entries.map((entry) => entry.kind);

describe("the view's reading of a diagnosis", () => {
	it("names the one obstacle between the evidence and a proposal", () => {
		expect(diagnosisReadingOf(brief({ proposalEligible: true }), 3)).toEqual({ evalRunId: "erun_1", proposable: true, obstacle: null, judgeAbstained: 3 });
		expect(diagnosisReadingOf(brief(), 6)).toMatchObject({ proposable: false, obstacle: "judge-abstained", judgeAbstained: 6 });
		expect(diagnosisReadingOf(brief(), 0)).toMatchObject({ obstacle: "unstable" });
		expect(diagnosisReadingOf(brief({ status: "healthy" }), 0)).toMatchObject({ obstacle: "nothing-failed" });
		expect(diagnosisReadingOf(brief({ status: "inconclusive" }), 2)).toMatchObject({ obstacle: "errored" });
	});

	it("points at the judge instead of a workshop when the judge could not decide", () => {
		const view = authoring(diagnosisReadingOf(brief(), 6));
		const next = workbenchNext(view);
		expect(kinds(next.submit)).not.toContain("workshop-open");
		expect(kinds(next.submit)).not.toContain("structured-proposal");
		expect(kinds(next.submit)).toContain("corpus-revision");
		expect(kinds(next.decide)).toEqual(expect.arrayContaining(["regrade", "calibrate", "run-current"]));
		expect(next.unblock).toMatch(/could not decide 6 verdict/);
		expect(next.unblock).toMatch(/kind: "regrade", graders: "draft"/);
		expect(next.unblock).toMatch(/Not a workshop/);
		expect(next.operatorNext).toEqual({ code: "next.judge-abstained" });
		expect(nextStep({ ...view, guidance: next })).toContain("say “re-score”");
		setLanguage("ru");
		expect(nextStep({ ...view, guidance: next })).toContain("скажи «пересчитай»");
	});

	it("asks for noise to be measured when nothing reproduces, and for cases when nothing failed", () => {
		const unstable = workbenchNext(authoring(diagnosisReadingOf(brief(), 0)));
		expect(unstable.operatorNext).toEqual({ code: "next.unstable" });
		expect(unstable.unblock).toMatch(/kind: "calibrate"/);
		expect(kinds(unstable.submit)).not.toContain("workshop-open");
		const healthy = workbenchNext(authoring(diagnosisReadingOf(brief({ status: "healthy" }), 0)));
		expect(healthy.operatorNext).toEqual({ code: "next.nothing-failed" });
		expect(healthy.unblock).toMatch(/harder cases/);
		const errored = workbenchNext(authoring(diagnosisReadingOf(brief({ status: "inconclusive" }), 0)));
		expect(errored.operatorNext).toEqual({ code: "next.errored" });
	});

	it("leaves the workshop door open where the evidence is proposable or unread", () => {
		for (const view of [authoring(diagnosisReadingOf(brief({ proposalEligible: true }), 0)), authoring()]) {
			const next = workbenchNext(view);
			expect(kinds(next.submit)).toEqual(expect.arrayContaining(["workshop-open", "structured-proposal"]));
			expect(next.unblock).toBe("look at the failures, then say “fix it”");
			expect(next.operatorNext).toEqual({ code: "next.improvement-authoring" });
		}
	});

	it("still re-attaches a recorded workshop over blocked evidence, so it can be closed or discarded", () => {
		const recorded: WorkbenchView["workshop"] = {
			state: "recorded", workshopId: "workshop_1", basis: "improvement", briefId: "brief-1", openedAt: "2026-09-07T00:00:00Z",
		};
		const next = workbenchNext(authoring(diagnosisReadingOf(brief(), 6), recorded));
		expect(kinds(next.submit)).toContain("workshop-open");
		expect(next.submit.find((entry) => entry.kind === "workshop-open")?.when).toContain('workshopId: "workshop_1"');
		expect(next.recovery).toEqual({ kind: "reattach-workshop", workshopId: "workshop_1" });
		expect(kinds(next.submit)).not.toContain("structured-proposal");
	});
});
