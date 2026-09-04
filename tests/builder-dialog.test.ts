import { afterEach, describe, expect, it, vi } from "vitest";
import { choose, confirmChoice, type DialogContext } from "../src/builder/dialog.js";
import { setLanguage, t } from "../src/i18n.js";

type SelectStub = ReturnType<typeof vi.fn<DialogContext["ui"]["select"]>>;

/** A host that answers with whatever `answer` picks out of the rendered labels. */
function host(answer: (labels: string[]) => string | undefined): { ctx: DialogContext; select: SelectStub } {
	const select = vi.fn(async (_title: string, labels: string[]) => answer(labels));
	return { ctx: { ui: { select } }, select };
}

afterEach(() => {
	setLanguage(null);
});

describe("a host dialog choice has an id", () => {
	it("resolves two identically rendered labels to two different ids", async () => {
		// The live shape: two failure modes whose titles are cut to the same 60
		// characters. Dispatching on the drawn string sends `/fix` to whichever
		// came first; dispatching on the id cannot.
		const same = () => "The agent answered without calling the lookup tool first…";
		const first = host((labels) => labels[0]);
		const second = host((labels) => labels[1]);
		const options = [{ id: "mode-a", label: same }, { id: "mode-b", label: same }] as const;

		expect(await choose(first.ctx, "Prepare a change?", options)).toBe("mode-a");
		expect(await choose(second.ctx, "Prepare a change?", options)).toBe("mode-b");

		// And the operator was not shown the same line twice either.
		const labels = second.select.mock.calls[0]?.[1] ?? [];
		expect(new Set(labels).size).toBe(labels.length);
		expect(labels[0]).toBe(same());
		expect(labels[1]).toBe(`${same()} (2)`);
	});

	it("keeps disambiguating until the label really is unused", async () => {
		const picked = host((labels) => labels[2]);
		const options = [
			{ id: "a", label: () => "Ambiguity" },
			{ id: "b", label: () => "Ambiguity (2)" },
			{ id: "c", label: () => "Ambiguity" },
		] as const;

		expect(await choose(picked.ctx, "Pick", options)).toBe("c");
		expect(picked.select.mock.calls[0]?.[1]).toEqual(["Ambiguity", "Ambiguity (2)", "Ambiguity (3)"]);
	});

	it("renders every label when the dialog opens, in the language of the moment", async () => {
		const seen: string[][] = [];
		const ctx: DialogContext = { ui: { select: async (_title, labels) => { seen.push(labels); return undefined; } } };
		const options = [{ id: "looking", label: () => t("review.just-looking") }] as const;

		setLanguage("en");
		await choose(ctx, "Pick", options);
		setLanguage("ru");
		await choose(ctx, "Pick", options);

		expect(seen).toEqual([["Just looking"], ["Просто смотрю"]]);
	});

	it("answers null for a dismissed dialog, an answer nobody offered, and a host with no selector", async () => {
		const options = [{ id: "yes", label: () => "Yes" }] as const;
		const dismissed = host(() => undefined);
		expect(await choose(dismissed.ctx, "Pick", options)).toBeNull();

		const invented = host(() => "Something the host made up");
		expect(await choose(invented.ctx, "Pick", options)).toBeNull();

		const empty = host((labels) => labels[0]);
		expect(await choose(empty.ctx, "Pick", [])).toBeNull();
		expect(empty.select).not.toHaveBeenCalled();

		const headless = { ui: {} } as unknown as DialogContext;
		expect(await choose(headless, "Pick", options)).toBeNull();
	});

	it("passes the host exactly what the caller gave it", async () => {
		const signal = new AbortController().signal;
		const bare = host((labels) => labels[0]);
		await choose(bare.ctx, "Pick", [{ id: "a", label: () => "A" }]);
		expect(bare.select).toHaveBeenCalledWith("Pick", ["A"]);

		const abortable = host((labels) => labels[0]);
		await choose(abortable.ctx, "Pick", [{ id: "a", label: () => "A" }], { signal });
		expect(abortable.select).toHaveBeenCalledWith("Pick", ["A"], { signal });
	});

	it("asks a two-way question through the same selector and answers true only on the yes", async () => {
		const yes = host((labels) => labels[0]);
		expect(await confirmChoice(yes.ctx, "Interrupted candidate", "review.abandon-attempt", "review.just-looking"))
			.toBe(true);
		expect(yes.select).toHaveBeenCalledWith("Interrupted candidate", ["Abandon this attempt", "Just looking"]);

		const no = host((labels) => labels[1]);
		expect(await confirmChoice(no.ctx, "Interrupted candidate", "review.abandon-attempt", "review.just-looking"))
			.toBe(false);

		const dismissed = host(() => undefined);
		expect(await confirmChoice(dismissed.ctx, "Interrupted candidate", "review.abandon-attempt", "review.just-looking"))
			.toBe(false);
	});

	it("draws the yes and the no in the operator's language", async () => {
		setLanguage("ru");
		const russian = host((labels) => labels[0]);
		await confirmChoice(russian.ctx, "Прерванный кандидат", "review.abandon-attempt", "review.just-looking");
		const labels = russian.select.mock.calls[0]?.[1] ?? [];
		expect(labels).toHaveLength(2);
		for (const label of labels) expect(label).toMatch(/[А-Яа-я]/);
	});
});
