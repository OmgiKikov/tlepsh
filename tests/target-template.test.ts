import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTargetTemplate } from "../src/application/target-template.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratchRoots: string[] = [];

function scratch(): string {
	const directory = mkdtempSync(join(tmpdir(), "ahde-template-test-"));
	scratchRoots.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of scratchRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Target template selection", () => {
	it.each([
		["python-support", "python-agent"],
		["python", "python-agent"],
		["pi-support", "support-agent"],
		["pi-basic", "basic-agent"],
		[undefined, "basic-agent"],
	] as const)("resolves %s from an empty consumer directory", (selection, folder) => {
		const directory = resolveTargetTemplate(selection, packageRoot, scratch());
		expect(directory).toBe(join(packageRoot, "templates", folder));
		expect(readFileSync(join(directory, "manifest.yaml"), "utf8")).toContain("id: my-agent");
	});

	it("keeps explicit paths local even when their basename is a built-in name", () => {
		const consumer = scratch();
		const custom = join(consumer, "python-support");
		mkdirSync(custom);
		writeFileSync(join(custom, "manifest.yaml"), "id: customer-template\n");
		expect(resolveTargetTemplate("./python-support", packageRoot, consumer)).toBe(custom);
		expect(resolveTargetTemplate(custom, packageRoot, scratch())).toBe(custom);
		expect(resolveTargetTemplate("python-support", packageRoot, consumer))
			.toBe(join(packageRoot, "templates", "python-agent"));
	});

	it("preserves a legacy relative template directory", () => {
		const consumer = scratch();
		const custom = join(consumer, "templates", "custom-agent");
		mkdirSync(custom, { recursive: true });
		writeFileSync(join(custom, "manifest.yaml"), "id: custom\n");
		expect(resolveTargetTemplate("templates/custom-agent", packageRoot, consumer)).toBe(custom);
	});

	it("explains available starters when a name or custom directory is missing", () => {
		expect(() => resolveTargetTemplate("pyhton", packageRoot, scratch()))
			.toThrow(/Choose python-support, pi-support, pi-basic.*--template \.\/path/);
	});

	it("detects an incomplete package before creating a Target", () => {
		expect(() => resolveTargetTemplate("python-support", scratch(), scratch()))
			.toThrow(/Template "python-support" has no manifest.yaml/);
	});
});
