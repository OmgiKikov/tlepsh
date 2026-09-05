import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { t } from "../../i18n.js";
import { workbenchNext } from "../../workbench/next-actions.js";
import type { WorkbenchView } from "../../workbench/types.js";
import { oneLine } from "./format.js";
import type { Paint } from "./paint.js";
import { renderHeader, type HeaderState } from "./view.js";
import { welcomeCopy } from "./welcome-copy.js";

/** Suggestions are text, never dispatch or authority. The host's current legal
 * moves decide which consequential intents are worth offering. */
export function welcomeIntents(view: WorkbenchView): string[] {
	const copy = welcomeCopy();
	const next = workbenchNext(view);
	if (next.recovery) {
		const recover = {
			"reattach-workshop": copy.workshop,
			"inspect-candidate": copy.candidate,
			"repair-integrity": copy.integrity,
			select: copy.selection,
		}[next.recovery.kind];
		return [recover, copy.inspect];
	}
	const can = (kind: string) => next.decide.some((entry) => entry.kind === kind);
	const intents: string[] = [];
	if (view.target.status === "bootstrap-required" && can("wrap-target")) intents.push(copy.connectPython);
	if (view.target.status === "missing" && can("scaffold-target")) intents.push(copy.create);
	if (view.target.status !== "missing" && can("configure-target")) intents.push(copy.configure);
	if (can("run-current") && (can("run-eval") || (can("start-testing") && view.counts.corpusDrafts > 0))) {
		intents.push(copy.run);
	}
	if (can("run-current") && can("verify-candidate")) intents.push(copy.verify);
	if (can("improve")) intents.push(copy.improve);
	if (can("model-experiment")) intents.push(copy.models);
	if (view.counts.approvedSpecs === 0 && next.submit.some((entry) => entry.kind === "spec-draft")) {
		intents.push(copy.describe);
	}
	if (view.counts.developmentEvals > 0) intents.push(copy.results);
	else if (view.counts.corpusDrafts > 0 || view.counts.developmentCorpora > 0) intents.push(copy.previewBasket);
	intents.push(copy.inspect);
	return [...new Set(intents)].slice(0, 3);
}

/** Keep the recognizable end of a long project path visible in a small TUI. */
function projectPath(path: string, width: number): string {
	const safe = oneLine(path, 4096);
	if (visibleWidth(safe) <= width) return safe;
	const chars = [...safe];
	let tail = "";
	for (let index = chars.length - 1; index >= 0; index--) {
		const next = `${chars[index]}${tail}`;
		if (visibleWidth(`…${next}`) > width) break;
		tail = next;
	}
	return `…${tail}`;
}

/** First-use and return presentation over the existing factual header. No new
 * inventory, workflow state, timers, confirmations, or remembered authority. */
export function renderWelcome(
	state: HeaderState,
	paint: Paint,
	options: { width: number; returning?: boolean },
): string[] {
	const width = Math.max(1, Math.floor(options.width));
	if (!state.view || state.error) {
		return renderHeader(state, paint).map((line) => truncateToWidth(line, width));
	}
	const copy = welcomeCopy();
	const view = state.view;
	const inset = width >= 40 ? "  " : "";
	const contentWidth = Math.max(1, width - visibleWidth(inset));
	const lines = [""];
	const add = (line: string) => lines.push(`${inset}${truncateToWidth(line, contentWidth)}`);
	const prose = (text: string, style: (value: string) => string = paint.muted) => {
		for (const line of wrapTextWithAnsi(style(oneLine(text, 1200)), contentWidth)) add(line);
	};
	add(`${paint.accent("◆")} ${paint.bold(t("header.title"))}`);
	prose(copy.tagline);
	add("");
	add(`${paint.dim(copy.project)} ${paint.bold(oneLine(view.project.id, 180))}`);
	add(paint.dim(projectPath(view.project.directory, contentWidth)));
	if (options.returning) {
		add("");
		add(paint.accent(copy.returning));
	}
	// Reuse every readiness, calibration, credential and integrity fact. The
	// old wordmark and help hint are presentation; the middle lines are facts.
	for (const fact of renderHeader(state, paint).slice(2, -2)) {
		for (const line of wrapTextWithAnsi(fact, contentWidth)) add(line);
	}
	add("");
	add(paint.dim(options.returning ? copy.continueWith : copy.trySaying));
	for (const intent of welcomeIntents(view)) {
		const prefix = `${paint.accent("›")} `;
		const continuation = "  ";
		const wrapped = wrapTextWithAnsi(intent, Math.max(1, contentWidth - 2));
		wrapped.forEach((line, index) => add(`${index === 0 ? prefix : continuation}${line}`));
	}
	add("");
	prose(copy.freeInput);
	lines.push("");
	return lines;
}
