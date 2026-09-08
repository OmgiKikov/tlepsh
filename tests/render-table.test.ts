import { beforeAll, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { setLanguage } from "../src/i18n.js";
import { caseLabel, table, visibleLength } from "../src/builder/render/format.js";
import { markerPaint, stripMarkers } from "../src/builder/transcript.js";
import { plainPaint } from "../src/builder/render/paint.js";
import { renderCandidateCases } from "../src/builder/render/view.js";
import type { WorkbenchCandidateCase } from "../src/workbench/candidate-cases.js";

const HASHED = `task-${"ab12".repeat(16)}`;

describe("table()", () => {
	it("aligns every column to its widest cell and never pads the last column", () => {
		const lines = table(
			[{ header: "#", align: "right" }, { header: "case" }, { header: "score", align: "right" }],
			[["1", "refund-policy", "33%"], ["10", "greeting", "100%"]],
			plainPaint,
		);
		expect(lines).toEqual([
			" #  case           score",
			"──  ─────────────  ─────",
			" 1  refund-policy    33%",
			"10  greeting        100%",
		]);
	});

	it("shrinks the flex columns to the budget and cuts their cells, never the fixed ones", () => {
		const long = "a very long case title that goes on and on and on and on and on";
		const lines = table(
			[{ header: "case", flex: true, min: 10 }, { header: "outcome" }, { header: "why", flex: true, min: 8 }],
			[[long, "✗ fail", `${long} ${long}`]],
			plainPaint,
			{ width: 60 },
		);
		for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(60);
		expect(lines[2]).toContain("✗ fail");
		expect(lines[2]).toContain("…");
	});

	it("paints a cell after cutting it, so the tone hides no width", () => {
		const lines = table(
			[{ header: "a", max: 5 }, { header: "b" }],
			[[{ text: "abcdefghij", tone: "error" }, { text: "ok", tone: "success" }]],
			markerPaint,
		);
		const row = lines[2]!;
		expect(stripMarkers(row)).toBe("abcd…  ok");
		expect(visibleLength(row)).toBe("abcd…  ok".length);
		expect(row).toContain(markerPaint.error("abcd…"));
	});

	it("can leave the rule out and right-align a single cell", () => {
		const lines = table([{ header: "n" }], [[{ text: "1", align: "right" }]], plainPaint, { rule: false });
		expect(lines).toEqual(["n", "1"]);
	});
});

describe("caseLabel()", () => {
	beforeAll(() => setLanguage("ru"));
	it("prints a written id whole, quotes a hashed case by its own words, and falls back to the short hash", () => {
		expect(caseLabel("refund-policy", "Где мой возврат?")).toBe("refund-policy");
		expect(caseLabel(HASHED, "Где мой возврат? Уже 10 дней прошло.")).toBe("«Где мой возврат?»");
		expect(caseLabel(HASHED, null)).toBe("task-ab12ab12…");
	});
});

describe("the candidate's case table", () => {
	beforeAll(() => setLanguage("ru"));
	const entry = (taskId: string, a: number, b: number, exclusion: WorkbenchCandidateCase["exclusion"] = null, total = 1): WorkbenchCandidateCase => ({
		taskId,
		input: null,
		baseline: { pass: Math.round(a * total), total, score: a },
		candidate: { pass: Math.round(b * total), total, score: b },
		scoreDelta: b - a,
		exclusion,
	});

	it("prints every case as before → after → delta, with the arrow the delta earns", () => {
		const lines = renderCandidateCases([entry("worse", 1, 0), entry("better", 0, 1), entry("same", 1, 1)], plainPaint).map(stripMarkers);
		expect(lines[0]).toBe("По кейсам");
		expect(lines[1]).toMatch(/^кейс\s+было\s+стало\s+Δ$/);
		expect(lines[3]).toMatch(/^worse\s+100%\s+0%\s+↓ -100 п\.п\.$/);
		expect(lines[4]).toMatch(/^better\s+0%\s+100%\s+↑ \+100 п\.п\.$/);
		expect(lines[5]).toMatch(/^same\s+100%\s+100%\s+= 0 п\.п\.$/);
	});

	it("shows pass fractions once a repetition happened, and a note column once a case was excluded", () => {
		const lines = renderCandidateCases([entry("a", 1 / 3, 1, null, 3), entry("b", 0, 0, "infrastructure", 3)], plainPaint).map(stripMarkers);
		expect(lines[1]).toMatch(/примечание$/);
		expect(lines[3]).toContain("1/3 · 33%");
		expect(lines[3]).toContain("3/3 · 100%");
		expect(lines[4]).toContain("· —");
		expect(lines[4]).toContain("исключён: инфраструктура");
	});

	it("stops at the limit and points to the next terminal page", () => {
		const many = Array.from({ length: 15 }, (_, index) => entry(`case-${index}`, 0, 1));
		const lines = renderCandidateCases(many, plainPaint, { limit: 12 }).map(stripMarkers);
		expect(lines.filter((line) => line.startsWith("case-"))).toHaveLength(12);
		expect(lines.at(-1)).toContain("ещё 3 кейсов");
		expect(lines.at(-1)).toContain("/review next");
	});

	it("prints nothing for a candidate with no cases", () => {
		expect(renderCandidateCases([], plainPaint)).toEqual([]);
	});
});

describe("clickable links", () => {
	it("wraps a URL or a written file in an OSC 8 hyperlink and leaves other words alone", async () => {
		const { hyperlink, linkTarget, themePaint } = await import("../src/builder/render/paint.js");
		expect(linkTarget("http://127.0.0.1:4310/evals/erun_1")).toBe("http://127.0.0.1:4310/evals/erun_1");
		expect(linkTarget("/tmp/agent/exports/version-v0.2.0.html")).toBe("file:///tmp/agent/exports/version-v0.2.0.html");
		expect(linkTarget("/tmp/агент/passport v1.md")).toBe(pathToFileURL("/tmp/агент/passport v1.md").href);
		expect(linkTarget("say /trace 1")).toBeNull();
		const paint = themePaint({ fg: (_color: string, text: string) => `<${text}>`, bold: (text: string) => text } as never);
		expect(paint.link("http://127.0.0.1:4310/evals/erun_1"))
			.toBe(hyperlink("<http://127.0.0.1:4310/evals/erun_1>", "http://127.0.0.1:4310/evals/erun_1"));
		expect(paint.link("Explorer")).toBe("<Explorer>");
		expect(hyperlink("x", "http://a")).toBe("\u001b]8;;http://a\u001b\\x\u001b]8;;\u001b\\");
	});
});
