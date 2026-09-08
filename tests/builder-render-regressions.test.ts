import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { hyperlink as nativeHyperlink, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { setLanguage } from "../src/i18n.js";
import { diffStats, renderUnifiedDiff } from "../src/builder/render/diff.js";
import { table, visibleLength } from "../src/builder/render/format.js";
import { hyperlink, linkTarget, plainPaint } from "../src/builder/render/paint.js";
import { hangingWrap, markerPaint, stripMarkers } from "../src/builder/transcript.js";

beforeEach(() => setLanguage("en"));

describe("faithful diff rendering", () => {
	it("treats header-shaped content inside a hunk as changed lines", () => {
		const diff = ["diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -1,2 +1,2 @@", "--- flag", "+++ heading", " unchanged"].join("\n");
		expect(diffStats(diff)).toEqual({ files: 1, added: 1, removed: 1 });
		const lines = renderUnifiedDiff(diff, plainPaint);
		expect(lines).toContain("  1     - -- flag");
		expect(lines).toContain("      1 + ++ heading");
		expect(lines).toContain("  2   2   unchanged");
	});

	it("retains modes and no-newline markers next to the affected row", () => {
		const lines = renderUnifiedDiff([
			"diff --git a/a b/a", "old mode 100644", "new mode 100755", "--- a/a", "+++ b/a",
			"@@ -1 +1 @@", "-before", "\\ No newline at end of file", "+after", "\\ No newline at end of file",
		].join("\n"), plainPaint);
		expect(lines.join("\n")).toContain("old mode 100644");
		expect(lines.join("\n")).toContain("new mode 100755");
		const removed = lines.findIndex((line) => line.includes("- before"));
		const added = lines.findIndex((line) => line.includes("+ after"));
		expect(lines[removed + 1]).toContain("\\ No newline at end of file");
		expect(lines[added + 1]).toContain("\\ No newline at end of file");
	});

	it.each([
		["diff --git a/a b/a", "old mode 100644", "new mode 100755"],
		["diff --git a/a b/a", "GIT binary patch", "literal 3", "KcmZQzU|?Vb0000", "literal 0", "HcmV?d00001"],
		["diff --git a/a b/a", "Binary files a/a and b/a differ"],
		["diff --cc a", "index a,b..c", "@@@ -1,1 -1,1 +1,1 @@@", "++merged"],
		["diff --git \"a/file name\" \"b/file name\"", "rename from file name", "rename to other name"],
		["unexpected patch preamble", "--- a/a", "+++ b/a", "@@ -1 +1 @@", "-old", "+new"],
		["diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -1,2 +1 @@", "-old", "+new"],
		["--- a/old-name", "+++ b/new-name", "@@ -1 +1 @@", "-old", "+new"],
		["diff --git a/a b/a", "--- a/a", "+++ b/a", "@@ -1 +1 @@", "-old", "+new", "--- extra deletion"],
	])("does not discard unsupported patch data: %j", (...source) => {
		const lines = renderUnifiedDiff(source.join("\n"), plainPaint);
		for (const line of source.filter((line) => !line.startsWith("diff --git "))) {
			expect(lines.join("\n")).toContain(line);
		}
	});

	it("bounds raw fallback output explicitly and handles huge context runs without spreading arrays", () => {
		const source = ["diff --cc a", "@@@ -1,1 -1,1 +1,1 @@@", "++changed"];
		expect(renderUnifiedDiff(source.join("\n"), plainPaint, { maxLines: 2 })).toEqual([
			...source.slice(0, 2), "… 1 more diff lines; open the full proposal artifact for the exact remainder",
		]);
		const context = `@@ -1,130000 +1,130000 @@\n${" same\n".repeat(130_000)}`;
		const lines = renderUnifiedDiff(context, plainPaint, { maxLines: 2 });
		expect(lines).toHaveLength(3);
		expect(lines.at(-1)).toContain("129998 more diff lines");
	});

	it("separates multiple non-git file patches and resets line numbers", () => {
		const diff = ["--- a/first", "+++ b/first", "@@ -1 +1 @@", "-a", "+b", "--- a/second", "+++ b/second", "@@ -9 +4 @@", "-c", "+d"].join("\n");
		expect(diffStats(diff)).toEqual({ files: 2, added: 2, removed: 2 });
		const lines = renderUnifiedDiff(diff, plainPaint);
		expect(lines).toContain("second  +1 -1");
		expect(lines).toContain("  9     - c");
		expect(lines).toContain("      4 + d");
	});
});

describe("terminal cell budgets", () => {
	it.each([0, 1, 2, 4, 8, 12, 24, 40])("fits Unicode and exhausted flex columns in %i cells", (width) => {
		const lines = table([
			{ header: "case", flex: true, min: 8 }, { header: "result" }, { header: "details" },
		], [[{ text: "界👩‍💻e\u0301".repeat(20), tone: "error" }, "long fixed result", "details".repeat(10)]], markerPaint, { width });
		for (const line of lines) expect(visibleWidth(stripMarkers(line))).toBeLessThanOrEqual(width);
	});

	it("uses grapheme widths for padding and does not count ANSI or links", () => {
		expect(visibleLength(markerPaint.bold(nativeHyperlink("界👩‍💻e\u0301", "https://example.com")))).toBe(5);
		const lines = table([{ header: "a" }, { header: "b" }], [["界", "x"], ["e\u0301", "y"], ["👩‍💻", "z"]], plainPaint);
		expect(lines.slice(2)).toEqual(["界  x", "e\u0301   y", "👩‍💻  z"]);
	});

	it.each([0, 1, 2, 3, 8, 20])("bounds continuation gutters in %i cells", (width) => {
		for (const line of [`${" ".repeat(200)}+ ${"界👩‍💻word ".repeat(8)}`, `123456789 123456789 - ${"word ".repeat(30)}`]) {
			const wrapped = hangingWrap(line, width);
			for (const part of wrapped) expect(visibleWidth(part)).toBeLessThanOrEqual(width);
			if (width >= 20) expect(stripTerminalSequences(wrapped.join(""))).toContain("word");
		}
	});
});

describe("safe native hyperlinks", () => {
	it("encodes filename spaces and URL delimiters as filesystem characters", () => {
		const path = "/tmp/agent files/report #1?.md";
		expect(linkTarget(path)).toBe(pathToFileURL(path).href);
		expect(linkTarget("/tmp/агент/passport v1.md")).toBe(pathToFileURL("/tmp/агент/passport v1.md").href);
		expect(hyperlink("report", pathToFileURL(path).href)).toBe(nativeHyperlink("report", pathToFileURL(path).href));
	});

	it.each(["javascript:alert(1)", "data:text/html,bad", "https://example.com\u001b]52;c;bad\u0007", "https://example.com\n", "/tmp/evil\u009c.md", "https://"])("rejects unsafe targets %j", (target) => {
		expect(linkTarget(target)).toBeNull();
		expect(hyperlink("safe", target)).toBe("safe");
	});
});
