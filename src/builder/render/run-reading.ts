import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { runReadingChange, type RunReading } from "../../application/run-reading.js";
import { t } from "../../i18n.js";
import type { Paint } from "./paint.js";

/** Browser, trace and exact run inspection all read the same recorded outcome. */
export function renderRunReadingLines(reading: RunReading, paint: Paint): string[] {
	const body = (text: string) => wrapTextWithAnsi(text, 96).map((line) => `  ${line}`);
	const lines = [paint.heading(reading.title)];
	if (reading.answerQuote) {
		lines.push(...body(`${t("reading.answer")}: “${reading.answerQuote.text}”`));
		if (reading.answerQuote.clipped) lines.push(...body(t("reading.quotedClip")));
	}
	for (const expectation of reading.expectations) lines.push(...body(expectation));
	for (const observation of reading.observations) lines.push(...body(observation));
	lines.push(paint.dim(t("reading.change")), ...body(runReadingChange(reading)));
	lines.push(paint.dim(t("reading.uncertain")));
	for (const uncertainty of reading.uncertainties) lines.push(...body(uncertainty));
	return lines;
}
