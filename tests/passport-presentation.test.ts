import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileBuilderPassport } from "../src/builder/passport-presentation.js";
import { cleanupPaths, terminalCandidateFixture, type CycleFixture } from "./helpers/cycle-fixtures.js";

let fixture: CycleFixture | undefined;

afterEach(() => {
	cleanupPaths(fixture);
	fixture = undefined;
});

function digest(content: Buffer): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

describe("Builder passport presentation", () => {
	it("binds the shipped passport to a verified card and the exact saved artifact", async () => {
		fixture = await terminalCandidateFixture(
			"promoted",
			{},
			{ baseline: "fail", candidate: "pass" },
		);

		const compiled = await compileBuilderPassport(fixture.workbench, { save: true });

		expect(compiled.card.release).toMatchObject({
			agent: fixture.projectId,
			version: fixture.tag,
			baselineSha: fixture.baselineSha,
			candidateSha: fixture.candidateSha,
		});
		expect(compiled.card.validation).toMatchObject({
			status: "known",
			value: { context: { status: "known", value: { surface: "development", blindDesign: null } } },
		});
		expect(compiled.card.change).toMatchObject({
			status: "known",
			value: {
				summary: "Make the evidence boundary explicit",
				proposalHash: compiled.passport.provenance.proposalSha256,
				paths: ["AGENTS.md"],
			},
		});

		const name = `passport-${fixture.tag}.md`;
		const path = join(fixture.projectDir, name);
		const content = readFileSync(path);
		expect(compiled.written).toBe(path);
		expect(readFileSync(compiled.written!, "utf8")).toBe(content.toString("utf8"));
		expect(compiled.card.artifacts.passport).toEqual({
			status: "known",
			value: { path: name, sha256: digest(content), bytes: content.length },
		});
		expect(compiled.reportWritten).toBe(join(fixture.projectDir, "exports", `version-${fixture.tag}.html`));
		const report = readFileSync(compiled.reportWritten!, "utf8");
		expect(report).toContain(fixture.candidateSha);
		expect(report).toContain(fixture.baselineSha);
		expect(report).toContain(`href="../${name}"`);
		expect(report).toContain("Make the evidence boundary explicit");
		expect(report).not.toContain("sealed-cycle-holdout");
		expect(report).not.toContain("erun_cycle_sealed");

		const serialized = JSON.stringify(compiled.card);
		expect(serialized).not.toContain("sealed-cycle-holdout");
		expect(serialized).not.toContain("erun_cycle_sealed_baseline");
		expect(serialized).not.toContain("erun_cycle_sealed_candidate");
	}, 60_000);

	it("keeps optional artifact facts unknown when the passport was not saved", async () => {
		fixture = await terminalCandidateFixture("promoted");

		const compiled = await compileBuilderPassport(fixture.workbench);

		expect(compiled.written).toBeNull();
		expect(compiled.reportWritten).toBeNull();
		expect(compiled.card.artifacts.passport).toEqual({
			status: "unknown",
			reason: "passport artifact was not supplied",
		});
		expect(existsSync(join(fixture.projectDir, `passport-${fixture.tag}.md`))).toBe(false);
		// Missing exact development runs narrow the card instead of inventing an impact.
		expect(compiled.card.capabilities.status).toBe("unknown");
		expect(compiled.card.resources.arms.status).toBe("unknown");
		expect(compiled.card.change.status).toBe("known");
	}, 60_000);
});
