import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	assertRestrictedGate,
	restrictedGate,
	RESTRICTED_DECISIONS,
	RestrictedGateDecisionError,
	UnrestrictedGateError,
	unattendedGate,
	type GateRestriction,
	type GateRestrictionId,
} from "../src/application/restricted-gate.js";
import {
	assertImprovementLoopGate,
	improvementLoopGate,
	IMPROVEMENT_LOOP_FORBIDDEN_DECISIONS,
	ImprovementLoopForbiddenDecisionError,
	runImprovementLoop,
} from "../src/application/improvement-loop.js";
import {
	assertProposalSearchGate,
	proposalSearchGate,
	PROPOSAL_SEARCH_FORBIDDEN_DECISIONS,
	ProposalSearchForbiddenDecisionError,
} from "../src/application/proposal-search.js";
import { setLanguage } from "../src/i18n.js";
import type { WorkbenchConfirmationKind, WorkbenchHumanGate } from "../src/workbench/types.js";

const CLI_SOURCE = readFileSync(fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "utf8");

function recordingGate(): WorkbenchHumanGate & { confirm: ReturnType<typeof vi.fn>; selectSealed: ReturnType<typeof vi.fn> } {
	return {
		confirm: vi.fn(async () => ({ approved: true, actorId: "local:human" })),
		selectSealed: vi.fn(async () => ({ approved: true, actorId: "local:human", selectedIndex: 0 })),
	};
}

function confirmation(kind: WorkbenchConfirmationKind) {
	return {
		kind,
		title: "t",
		reason: "r",
		subject: {},
		subjectHash: `sha256:${"0".repeat(64)}`,
		policy: "consequential" as const,
		question: "q?",
	};
}

/**
 * The two front doors that run the Target without a human watching each step.
 * They are the same restriction with two names, so every rule below is stated
 * once and asserted twice.
 */
const RESTRICTIONS: readonly {
	id: GateRestrictionId;
	/** The public name the rest of the tree still calls it by. */
	wrap: (gate: WorkbenchHumanGate) => WorkbenchHumanGate;
	assert: (gate: WorkbenchHumanGate | undefined) => void;
	forbidden: readonly WorkbenchConfirmationKind[];
	legacyError: typeof RestrictedGateDecisionError;
	/** What the operator is told to do instead, in English. */
	advice: string;
	/** The other restriction's wrapper: a brand is never transferable. */
	foreign: (gate: WorkbenchHumanGate) => WorkbenchHumanGate;
}[] = [
	{
		id: "improvement-loop",
		wrap: improvementLoopGate,
		assert: assertImprovementLoopGate,
		forbidden: IMPROVEMENT_LOOP_FORBIDDEN_DECISIONS,
		legacyError: ImprovementLoopForbiddenDecisionError,
		advice: "Stop the loop and make it yourself.",
		foreign: proposalSearchGate,
	},
	{
		id: "proposal-search",
		wrap: proposalSearchGate,
		assert: assertProposalSearchGate,
		forbidden: PROPOSAL_SEARCH_FORBIDDEN_DECISIONS,
		legacyError: ProposalSearchForbiddenDecisionError,
		advice: "Read the table, pick a candidate, and decide it yourself.",
		foreign: improvementLoopGate,
	},
];

afterEach(() => {
	setLanguage(null);
});

describe("one restricted gate", () => {
	it("lists the fifteen decisions once, and never the apply the operator asked for", () => {
		expect(IMPROVEMENT_LOOP_FORBIDDEN_DECISIONS).toBe(RESTRICTED_DECISIONS);
		expect(PROPOSAL_SEARCH_FORBIDDEN_DECISIONS).toBe(RESTRICTED_DECISIONS);
		expect(RESTRICTED_DECISIONS).not.toContain("apply-proposal");
		for (const kind of ["promote-candidate", "adopt-candidate", "publish-corpus", "approve-spec", "ship"] as const) {
			expect(RESTRICTED_DECISIONS).toContain(kind);
		}
	});

	it.each(RESTRICTIONS)("$id throws on every decision that creates release authority", async (restriction) => {
		const inner = recordingGate();
		const guarded = restriction.wrap(inner);
		for (const kind of restriction.forbidden) {
			await expect(guarded.confirm(confirmation(kind)))
				.rejects.toThrow(RestrictedGateDecisionError);
			// The name each module still exports is the same class, so a caller
			// that catches the old one catches this.
			await expect(guarded.confirm(confirmation(kind))).rejects.toThrow(restriction.legacyError);
		}
		await expect(guarded.selectSealed({ title: "pick", options: [] }))
			.rejects.toThrow(/sealed holdout selection/);
		expect(inner.confirm).not.toHaveBeenCalled();
		expect(inner.selectSealed).not.toHaveBeenCalled();
	});

	it.each(RESTRICTIONS)("$id lets routine measurement and the asked-for apply through", async (restriction) => {
		const inner = recordingGate();
		const guarded = restriction.wrap(inner);
		for (const kind of ["run-eval", "verify-candidate", "apply-proposal", "improve"] as const) {
			await expect(guarded.confirm(confirmation(kind))).resolves.toMatchObject({ approved: true });
		}
		expect(inner.confirm).toHaveBeenCalledTimes(4);
	});

	it.each(RESTRICTIONS)("$id says which decision it refused and what the human does instead", async (restriction) => {
		const guarded = restriction.wrap(recordingGate());
		const error = await guarded.confirm(confirmation("promote-candidate")).catch((thrown: unknown) => thrown);
		expect(error).toBeInstanceOf(RestrictedGateDecisionError);
		const refusal = error as RestrictedGateDecisionError;
		expect(refusal.decision).toBe("promote-candidate");
		expect(refusal.restriction).toBe(restriction.id);
		expect(refusal.message).toContain("promote-candidate");
		expect(refusal.message).toContain(restriction.advice);
	});

	it.each(RESTRICTIONS)("$id refuses in the operator's language", async (restriction) => {
		setLanguage("ru");
		const guarded = restriction.wrap(recordingGate());
		const thrown = await guarded.confirm(confirmation("ship")).catch((error: unknown) => error);
		expect(thrown).toBeInstanceOf(RestrictedGateDecisionError);
		const refusal = thrown as RestrictedGateDecisionError;
		// The decision kind is an id and stays exactly as it is; the sentence
		// around it is the operator's.
		expect(refusal.message).toContain("ship");
		expect(refusal.message).toMatch(/[А-Яа-я]/);
		expect(refusal.message).not.toContain("stays with the human");
	});

	it.each(RESTRICTIONS)("$id accepts only a gate branded for it, and treats no gate as no question", (restriction) => {
		const raw = recordingGate();
		expect(() => restriction.assert(restriction.wrap(raw))).not.toThrow();
		expect(() => restriction.assert(undefined)).not.toThrow();
		expect(() => restriction.assert(raw)).toThrow(UnrestrictedGateError);
		// A brand is not transferable: the other operation's gate is still an
		// unwrapped gate here.
		expect(() => restriction.assert(restriction.foreign(raw))).toThrow(UnrestrictedGateError);
		expect(() => assertRestrictedGate(raw, restriction.id)).toThrow(/only be handed a gate wrapped by/);
	});

	it("keeps the brand off anything that copies the gate", async () => {
		const guarded = improvementLoopGate(recordingGate());
		const copy: WorkbenchHumanGate = { ...guarded };
		expect(() => assertImprovementLoopGate(copy)).toThrow(UnrestrictedGateError);
		expect(JSON.stringify(guarded)).toBe("{}");
	});

	it("takes the advice from the restriction rather than from the id", async () => {
		const restriction: GateRestriction = { id: "improvement-loop", advice: "gate.restricted.advice.pick-candidate" };
		const guarded = restrictedGate(recordingGate(), restriction);
		await expect(guarded.confirm(confirmation("ship")))
			.rejects.toThrow(/Read the table, pick a candidate/);
	});
});

describe("the gate a run nobody is watching stands on", () => {
	it("refuses every question instead of answering yes for the absent human", async () => {
		const gate = unattendedGate();
		await expect(gate.confirm(confirmation("run-eval"))).resolves.toEqual({ approved: false });
		await expect(gate.selectSealed({ title: "pick", options: [] })).resolves.toEqual({ approved: false });
	});
});

describe("the `ahde improve` front door", () => {
	it("refuses to start when it was handed a gate that could still approve a release", async () => {
		const raw = recordingGate();
		// Nothing is read, resolved or spent: the refusal comes before the first
		// touch of the repository, which does not even have to exist.
		await expect(runImprovementLoop({
			repositoryDir: "/nonexistent/improve/target",
			runsRoot: "/nonexistent/improve/runs",
			stateRoot: "/nonexistent/improve/state",
			projectId: "demo",
			approvedSpecId: `spec-${"a".repeat(64)}`,
			until: 1,
			maxCycles: 1,
			repetitions: 1,
			author: () => ({ kind: "no-change", reason: "never reached" }),
			gate: raw,
		})).rejects.toThrow(UnrestrictedGateError);
		expect(raw.confirm).not.toHaveBeenCalled();
	});

	it("hands the loop and the search a restricted gate from the CLI too", () => {
		// `ahde improve` used to call the loop with no gate at all while the
		// Workbench wrapped one, so invariant 6 was enforced on one of the two
		// front doors. Read the source: this is the wiring, not a behaviour.
		const call = (name: string): string => {
			const start = CLI_SOURCE.indexOf(`await ${name}({`);
			expect(start, name).toBeGreaterThan(-1);
			return CLI_SOURCE.slice(start, CLI_SOURCE.indexOf("\n\t\t\t});", start));
		};
		expect(call("runImprovementLoop")).toContain("gate: improvementLoopGate(unattendedGate())");
		expect(call("runProposalSearch")).toContain("gate: proposalSearchGate(unattendedGate())");
	});
});
