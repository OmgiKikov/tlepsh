import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { setLanguage } from "../src/i18n.js";
import { plainPaint, type Paint } from "../src/builder/render/paint.js";
import { renderWelcome, welcomeIntents } from "../src/builder/render/welcome.js";
import type { HeaderState } from "../src/builder/render/view.js";
import type { WorkbenchView } from "../src/workbench/types.js";

function state(overrides: Partial<WorkbenchView> = {}): HeaderState {
	return {
		builderModel: { label: "openai/builder", credentialPresent: true },
		view: {
			schemaVersion: 1,
			project: { id: "support-agent", directory: "/Users/operator/projects/customer-support" },
			stage: "target-setup",
			headline: "Create the agent",
			target: { status: "missing", id: null, gitSha: null, model: null },
			focus: {}, selections: [], actions: ["scaffold-target"], blockers: [], warnings: [], calibration: null,
			counts: { specDrafts: 0, approvedSpecs: 0, corpusDrafts: 0, developmentCorpora: 0,
				sealedCorpora: 0, developmentEvals: 0, openProposals: 0, candidates: 0, calibrations: 0 },
			...overrides,
		},
	};
}

const ansiPaint: Paint = Object.fromEntries(Object.keys(plainPaint).map((key) =>
	[key, (text: string) => `\u001b[38;5;173m${text}\u001b[0m`])) as unknown as Paint;

afterEach(() => setLanguage("en"));

describe("contextual Builder welcome", () => {
	it.each(["ru", "en"] as const)("fits ANSI and wide characters at 32/60/100/140 columns in %s", (language) => {
		setLanguage(language);
		const current = state({ project: { id: "Поддержка 顧客", directory: "/projects/очень-длинное-название/顧客-support" } });
		for (const width of [32, 60, 100, 140]) {
			const lines = renderWelcome(current, ansiPaint, { width });
			expect(lines.length).toBeLessThan(35);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("names the actual project and preserves its path suffix without control sequences", () => {
		const current = state({ project: { id: "safe\u001b[2J-project", directory: "/a/very/long/project/path/with/other/segments/customer-support" } });
		const text = renderWelcome(current, plainPaint, { width: 32 }).join("\n");
		expect(text).toContain("safe-project");
		expect(text).toContain("customer-support");
		expect(text).not.toContain("\u001b[2J");
		expect(text).not.toMatch(/0 runs|100%|improved/i);
	});

	it("offers Python connection only when wrapping is an available move", () => {
		setLanguage("ru");
		const current = state({
			target: { status: "bootstrap-required", id: null, gitSha: null, model: null },
			guidance: { unblock: "connect", decide: [{ kind: "wrap-target", asks: true, when: "connect" }], submit: [] },
		}).view!;
		expect(welcomeIntents(current)).toContain("Подключить Python-агента");
		current.guidance!.decide = [];
		expect(welcomeIntents(current)).not.toContain("Подключить Python-агента");
		expect(welcomeIntents(state().view!)).not.toContain("Прогнать корзину");
	});

	it("offers run, improvement and model selection only from current canonical guidance", () => {
		setLanguage("ru");
		const current = state({
			stage: "improvement-authoring",
			guidance: { unblock: "improve", decide: [
				{ kind: "run-current", asks: false, when: "run" },
				{ kind: "run-eval", asks: false, when: "run" },
				{ kind: "improve", asks: true, when: "improve" },
				{ kind: "model-experiment", asks: true, when: "model" },
			], submit: [] },
		}).view!;
		expect(welcomeIntents(current)).toEqual([
			"Прогнать корзину", "Улучшить ответы, на которых агент ошибается", "Подобрать агенту модель дешевле",
		]);
		current.guidance!.decide = [];
		expect(welcomeIntents(current)).toEqual(["Покажи текущее состояние проекта"]);
	});

	it("offers reviewing and running an existing draft basket without inventing one", () => {
		const current = state({
			stage: "corpus-review", counts: { ...state().view!.counts, approvedSpecs: 1, corpusDrafts: 1 },
			guidance: { unblock: "review", decide: [
				{ kind: "run-current", asks: true, when: "run" },
				{ kind: "start-testing", asks: true, when: "run" },
			], submit: [] },
		}).view!;
		expect(welcomeIntents(current)).toEqual([
			"Run the test basket", "Show me the basket before running it", "Show me the project's current state",
		]);
		current.counts.corpusDrafts = 0;
		expect(welcomeIntents(current)).toEqual(["Show me the project's current state"]);
	});

	it.each([
		{ kind: "reattach-workshop", workshopId: "workshop-1" },
		{ kind: "inspect-candidate", candidateId: "candidate-1" },
		{ kind: "repair-integrity" },
		{ kind: "select" },
	] as const)("prioritizes $kind recovery instead of suggesting another mutation", (recovery) => {
		const current = state({
			guidance: { unblock: "recover", recovery,
				decide: [{ kind: "improve", asks: true, when: "improve" }], submit: [] },
		}).view!;
		const intents = welcomeIntents(current);
		expect(intents).toHaveLength(2);
		expect(intents[0]).toMatch(/Continue|Show|Help/);
		expect(intents.join(" ")).not.toContain("Improve the agent");
	});

	it("retains missing credentials, recorded evidence and recovery in a returning project", () => {
		const current = state({
			stage: "candidate-verification",
			target: { status: "ready", id: "agent-actual", gitSha: "a".repeat(40),
				model: { provider: "openai", id: "target", apiKeyEnv: "OPENAI_API_KEY", credentialPresent: false } },
			counts: { ...state().view!.counts, developmentEvals: 4, openProposals: 1 },
			guidance: { unblock: "inspect", operatorNext: { code: "next.interrupted" },
				recovery: { kind: "inspect-candidate", candidateId: "candidate-actual" }, decide: [], submit: [] },
		});
		const text = renderWelcome(current, plainPaint, { width: 140, returning: true }).join("\n");
		expect(text).toContain("WELCOME BACK");
		expect(text).toContain("agent-actual");
		expect(text).toContain("OPENAI_API_KEY missing");
		expect(text).toContain("4 eval runs");
		expect(text).toContain("1 open proposal");
		expect(text).toContain("Show the interrupted attempt");
		expect(text).not.toContain("approved changes");
	});

	it("keeps unreadable state on the existing error surface without inviting mutations", () => {
		const current = state();
		current.error = "Artifact is unreadable";
		const text = renderWelcome(current, plainPaint, { width: 60 }).join("\n");
		expect(text).toContain("Project state unavailable");
		expect(text).not.toContain("Start with your intent");
	});
});
