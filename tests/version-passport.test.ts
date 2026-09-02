import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	compileVersionPassport,
	renderVersionPassportMarkdown,
} from "../src/application/version-passport.js";
import { registerAhdeBuilderCommands } from "../src/builder/commands.js";
import { renderVersionPassport } from "../src/builder/render/passport.js";
import { plainPaint } from "../src/builder/render/paint.js";
import { stripMarkers, type TranscriptPresenter, type TranscriptTone } from "../src/builder/transcript.js";
import { cleanupPaths, terminalCandidateFixture, type CycleFixture } from "./helpers/cycle-fixtures.js";

let fixture: CycleFixture | undefined;

afterEach(() => {
	cleanupPaths(fixture);
	fixture = undefined;
});

/** The registered command plus everything it showed the operator. */
function commands(shipped: CycleFixture): {
	run(name: string, args: string): Promise<void>;
	blocks: { title: string; tone: TranscriptTone; lines: string[] }[];
	text(): string;
} {
	const blocks: { title: string; tone: TranscriptTone; lines: string[] }[] = [];
	const presenter: TranscriptPresenter = {
		show: (_ctx, block) => {
			blocks.push({ title: block.title, tone: block.tone ?? "info", lines: block.lines });
		},
		note: () => undefined,
	};
	const registered = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const pi = {
		registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
			registered.set(name, options);
		},
	} as unknown as ExtensionAPI;
	registerAhdeBuilderCommands(pi, {
		workbench: shipped.workbench,
		actorId: () => "local:passport-operator",
		presenter,
	});
	const ctx = {
		hasUI: true,
		mode: "tui",
		waitForIdle: async () => undefined,
		ui: { notify: vi.fn(), select: vi.fn(), input: vi.fn(), confirm: vi.fn() },
	} as unknown as ExtensionCommandContext;
	return {
		run: async (name, args) => {
			const command = registered.get(name);
			if (!command) throw new Error(`command /${name} was never registered`);
			await command.handler(args, ctx);
		},
		blocks,
		text: () => blocks.flatMap((block) => block.lines).map(stripMarkers).join("\n"),
	};
}

describe("version passport", () => {
	it("says what the version promised, what it measured, and what is still unknown", async () => {
		fixture = await terminalCandidateFixture("promoted");
		const passport = compileVersionPassport({
			runsRoot: fixture.runsRoot,
			stateRoot: fixture.stateRoot,
			projectId: fixture.projectId,
			model: { provider: "mock", id: "model" },
		});
		expect(passport).toMatchObject({
			schemaVersion: 1,
			version: fixture.tag,
			baselineSha: fixture.baselineSha,
			candidateSha: fixture.candidateSha,
			model: { provider: "mock", id: "model" },
		});
		// Promised: the approved Spec's own words, not a paraphrase of them.
		expect(passport.promised?.successCriteria).toEqual(["Answer contains the applicable policy"]);
		expect(passport.promised?.constraints).toEqual(["Never invent policy"]);
		// Measured: the development numbers, the sealed verdict, the ratios.
		expect(passport.measured.development).toMatchObject({
			verdict: "improved",
			tasks: 15,
			repetitions: 2,
			baselinePassRate: 0,
			candidatePassRate: 1,
			scoreDelta: 1,
		});
		expect(passport.measured.sealed).toEqual({ verdict: "pass", tasks: 15, repetitions: 2, outcome: "improved" });
		expect(passport.measured.resources).toMatchObject({ costRatio: 1.4, latencyRatio: 0.9, tokenRatio: 1.125 });
		// Nobody has labelled anything, so the judge is honestly unknown.
		expect(passport.judge).toBeNull();
		// Nothing was calibrated on this revision, and no diagnosis was cited.
		expect(passport.limits.noise).toBeNull();
		expect(passport.limits.unresolvedModes).toEqual([]);
		expect(passport.limits.sealedTasks).toBe(15);
		expect(passport.provenance).toMatchObject({
			candidateId: fixture.candidateId,
			approvedSpecId: fixture.approvedSpecId,
			proposalRunId: fixture.proposalRunId,
			appliedVia: null,
		});
	}, 60_000);

	it("names the exam by its size and never by its identity", async () => {
		fixture = await terminalCandidateFixture("promoted");
		const passport = compileVersionPassport({
			runsRoot: fixture.runsRoot,
			stateRoot: fixture.stateRoot,
			projectId: fixture.projectId,
		});
		const markdown = renderVersionPassportMarkdown(passport);
		const panel = renderVersionPassport(passport, plainPaint).join("\n");
		for (const surface of [markdown, panel, JSON.stringify(passport)]) {
			// The sealed corpus, its eval runs, and its cases stay evaluator-only.
			expect(surface).not.toContain("sealed-cycle-holdout");
			expect(surface).not.toContain("erun_cycle_sealed_baseline");
			expect(surface).not.toContain("erun_cycle_sealed_candidate");
		}
		expect(markdown).toContain("- Sealed exam: pass · improved on 15 × 2 (contents evaluator-only)");
		expect(panel).toContain("Sealed exam pass · improved on 15 × 2 · contents stay evaluator-only");
		// Every panel line stays inside the terminal budget.
		for (const line of renderVersionPassport(passport, plainPaint)) {
			expect(line.length).toBeLessThanOrEqual(120);
		}
	}, 60_000);

	it("renders the whole page as markdown, section by section", async () => {
		fixture = await terminalCandidateFixture("promoted");
		const markdown = renderVersionPassportMarkdown(compileVersionPassport({
			runsRoot: fixture.runsRoot,
			stateRoot: fixture.stateRoot,
			projectId: fixture.projectId,
			model: { provider: "mock", id: "model" },
		}));
		expect(markdown).toContain(`# ${fixture.projectId} ${fixture.tag}`);
		for (const heading of ["## Promised", "## Measured", "## Judge", "## Known limits", "## Provenance"]) {
			expect(markdown).toContain(heading);
		}
		expect(markdown).toContain("- Answer contains the applicable policy");
		expect(markdown).toContain("- Never invent policy");
		expect(markdown).toContain("judge not calibrated — nobody has checked it against a human");
		expect(markdown).toContain("- Noise: never measured on this revision");
		expect(markdown).toContain("who read the exact diff");
	}, 60_000);

	it("refuses to invent a version that was never shipped", async () => {
		fixture = await terminalCandidateFixture("rejected");
		const input = { runsRoot: fixture.runsRoot, stateRoot: fixture.stateRoot, projectId: fixture.projectId };
		expect(() => compileVersionPassport(input)).toThrow(/nothing has been promoted yet/);
		fixture = await (async () => {
			cleanupPaths(fixture);
			return terminalCandidateFixture("promoted");
		})();
		expect(() => compileVersionPassport({
			runsRoot: fixture!.runsRoot,
			stateRoot: fixture!.stateRoot,
			projectId: fixture!.projectId,
			version: "9.9.9",
		})).toThrow(/no promoted version 9\.9\.9/);
		// The operator's `v` is optional; the tag is the same version either way.
		expect(compileVersionPassport({
			runsRoot: fixture!.runsRoot,
			stateRoot: fixture!.stateRoot,
			projectId: fixture!.projectId,
			version: "1.0.0",
		}).version).toBe("v1.0.0");
	}, 120_000);
});

describe("/passport and /log", () => {
	it("puts the passport on screen and beside the agent, without the CLI", async () => {
		fixture = await terminalCandidateFixture("promoted");
		const host = commands(fixture);
		await host.run("passport", "");
		expect(host.blocks.map((block) => block.title)).toEqual(["AHDE · Passport"]);
		const shown = host.text();
		expect(shown).toContain(fixture.tag);
		expect(shown).toContain("Answer contains the applicable policy");
		expect(shown).toContain("not calibrated");
		// The same page is saved beside the agent, ready to send to someone else.
		const file = join(fixture.projectDir, `passport-${fixture.tag}.md`);
		expect(existsSync(file)).toBe(true);
		expect(readFileSync(file, "utf8")).toContain("## Measured");
		expect(shown).toContain(`Written to passport-${fixture.tag}.md`);
	}, 60_000);

	it("shows the growth log for the agent", async () => {
		fixture = await terminalCandidateFixture("promoted");
		const host = commands(fixture);
		await host.run("log", "");
		expect(host.blocks.map((block) => block.title)).toEqual(["AHDE · Growth"]);
		const shown = host.text();
		expect(shown).toContain("Growth");
		expect(shown).toContain(fixture.tag);
		expect(shown).toContain("sealed pass on 15×2");
		// A mistyped argument is a panel in the transcript, not Pi's raw
		// `Extension "command:log" error:` with a stack under it.
		await host.run("log", "not-a-number");
		expect(host.blocks.at(-1)).toMatchObject({ title: "AHDE · /log" });
		expect(host.text()).toMatch(/takes how many rows to show/);
		await host.run("passport", "1.0.0 extra");
		expect(host.blocks.at(-1)).toMatchObject({ title: "AHDE · /passport" });
		expect(host.text()).toMatch(/at most one version/);
	}, 60_000);
});
