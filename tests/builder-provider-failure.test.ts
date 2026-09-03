import { describe, expect, it } from "vitest";
import { t } from "../src/i18n.js";
import { safeProviderFailure } from "../src/builder/product-shell.js";

/**
 * Live session 8: OpenRouter answered a wrong URL with `404` and its whole web
 * page; the page contained the word "authentication", and the operator read
 * "the model refused the key" while the key was fine. The status code decides
 * first, and words never come from a document.
 */
describe("safeProviderFailure", () => {
	it("reads the status code before any word", () => {
		expect(safeProviderFailure("404 <!DOCTYPE html><html><body>authentication required</body></html>")).toBe(t("model.not-found"));
		expect(safeProviderFailure("401 Unauthorized")).toBe(t("model.auth-rejected"));
		expect(safeProviderFailure("403 forbidden")).toBe(t("model.auth-rejected"));
		expect(safeProviderFailure("429 slow down")).toBe(t("model.rate-limited"));
		expect(safeProviderFailure("502 Bad Gateway")).toBe(t("model.failed"));
	});

	it("never lets an HTML body speak", () => {
		expect(safeProviderFailure("<html><body>invalid api key</body></html>")).toBe(t("model.failed"));
	});

	it("still reads the words of a plain message", () => {
		expect(safeProviderFailure("Unauthorized: bad bearer")).toBe(t("model.auth-rejected"));
		expect(safeProviderFailure("model not found")).toBe(t("model.not-found"));
		expect(safeProviderFailure("fetch failed: ECONNREFUSED")).toBe(t("model.unreachable"));
		expect(safeProviderFailure(undefined)).toBe(t("model.failed"));
	});
});
