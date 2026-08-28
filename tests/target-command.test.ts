import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInteractiveTargetDirectory } from "../src/target/command.js";

describe("interactive Target CLI selection", () => {
	it("defaults to the invocation directory when --target is omitted", () => {
		const invocationDirectory = resolve("fixtures", "current-target");

		expect(resolveInteractiveTargetDirectory(undefined, invocationDirectory))
			.toBe(invocationDirectory);
	});

	it("retains explicit relative and absolute --target selection", () => {
		const invocationDirectory = resolve("fixtures", "launcher");
		const absoluteTarget = resolve("fixtures", "absolute-target");

		expect(resolveInteractiveTargetDirectory("../relative-target", invocationDirectory))
			.toBe(join(resolve("fixtures"), "relative-target"));
		expect(resolveInteractiveTargetDirectory(absoluteTarget, invocationDirectory))
			.toBe(absoluteTarget);
	});
});
