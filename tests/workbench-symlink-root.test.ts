import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalPath, createAhdeWorkbench } from "../src/workbench/workbench.js";
import { cleanupPaths, terminalCandidateFixture, type CycleFixture } from "./helpers/cycle-fixtures.js";

let fixture: CycleFixture | undefined;
const extra: string[] = [];

afterEach(() => {
	cleanupPaths(fixture);
	fixture = undefined;
	for (const path of extra.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Workbench opened through a symlinked root", () => {
	it("admits candidates whose provenance was written under the canonical path", async () => {
		fixture = await terminalCandidateFixture("promoted");
		const direct = await fixture.workbench.view();
		expect(direct.blockers).toEqual([]);
		expect(direct.stage).toBe("candidate-adoption");

		// macOS spells the temp root two ways (/var → /private/var); simulate that
		// with an explicit symlink so the test holds on every platform.
		const linkRoot = mkdtempSync(join(tmpdir(), "ahde-symlink-"));
		extra.push(linkRoot);
		const link = join(linkRoot, "project");
		symlinkSync(fixture.projectDir, link, "dir");

		const viaLink = createAhdeWorkbench({
			projectDir: link,
			stateRoot: join(link, ".ahde"),
			runsRoot: join(link, "runs"),
			projectId: fixture.projectId,
		});
		expect(viaLink.projectDir).toBe(canonicalPath(fixture.projectDir));
		expect(viaLink.runsRoot).toBe(canonicalPath(fixture.runsRoot));
		const view = await viaLink.view();
		expect(view.blockers).toEqual([]);
		expect(view.warnings).toEqual(direct.warnings);
		expect(view.stage).toBe("candidate-adoption");
		expect(view.counts).toEqual(direct.counts);
		const review = await viaLink.view({ aspect: "review" });
		expect(review.detail?.aspect === "review" && review.detail.content.kind === "candidate" && review.detail.content.candidateId).toBe(fixture.candidateId);
	});

	it("canonicalizes the deepest existing ancestor of paths that do not exist yet", () => {
		const root = mkdtempSync(join(tmpdir(), "ahde-canonical-"));
		extra.push(root);
		const link = join(root, "link");
		symlinkSync(root, link, "dir");
		const real = canonicalPath(root);
		expect(canonicalPath(link)).toBe(real);
		expect(canonicalPath(join(link, "missing", "deeper"))).toBe(join(real, "missing", "deeper"));
		expect(basename(canonicalPath(join(link, "x")))).toBe("x");
		expect(dirname(canonicalPath(join(link, "x")))).toBe(real);
	});
});
