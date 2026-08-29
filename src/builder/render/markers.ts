/**
 * Private-use characters that carry styling intent through persisted
 * transcript entries. They are the only non-printing characters AHDE ever
 * emits on purpose, so every artifact-authored string strips them.
 */
export const MARKER_OPEN = "";
export const MARKER_CLOSE = "";
export const MARKER_CODES = "ahbdmswe+\\-l";

const OPEN_WITH_CODE = new RegExp(`${MARKER_OPEN}[${MARKER_CODES}]`, "gu");
const ANY_MARKER = new RegExp(`[${MARKER_OPEN}${MARKER_CLOSE}]`, "gu");

/** Remove every marker (with its code letter) and leave the visible text untouched. */
export function stripMarkers(line: string): string {
	return line.replace(OPEN_WITH_CODE, "").replace(ANY_MARKER, "");
}
