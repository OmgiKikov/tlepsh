import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { MAX_WORLD_BYTES, WorldSchema, type World, type WorldExpectation } from "../manifest.js";
import { canonicalJson } from "../provenance.js";

/**
 * The three operations a world supports, and the one bounded reader that turns
 * a file back into a world state.
 *
 * This module is the ONLY place `equals`, `exists` and `contains` are decided.
 * The grader, the card and any future reader of a finished world all come
 * through here, so an expectation written in a dataset and the same expectation
 * read off a run mean exactly one thing.
 *
 * It is pure with respect to the world: it reads a file and answers questions
 * about a value. It never writes, never executes, and never learns anything
 * about the agent that produced the state it is handed.
 */

/** The names that turn an object walk into prototype pollution. */
const RESERVED_WORLD_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/** One path segment: a key, or a decimal array index. Never a wildcard. */
const WORLD_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** How much of a value a reason may quote. A reason is read, not parsed back. */
export const MAX_WORLD_REASON_VALUE_CHARS = 120;

/** What a dotted path found. `found` distinguishes an absent path from a `null`. */
export interface WorldLookup {
	found: boolean;
	value: unknown;
}

function bounded(text: string): string {
	return text.length <= MAX_WORLD_REASON_VALUE_CHARS
		? text
		: `${text.slice(0, MAX_WORLD_REASON_VALUE_CHARS - 1)}…`;
}

/** One value as a reason quotes it: canonical JSON, bounded. */
function shown(value: unknown): string {
	return value === undefined ? "nothing" : bounded(canonicalJson(value));
}

/**
 * Walk a dotted path over a world state.
 *
 * A malformed path or one that names a reserved property throws rather than
 * answering: the manifest's path regex admits `__proto__` as a spelling, and a
 * lookup that quietly returned `Object.prototype` would answer a question
 * nobody asked. Grading turns that throw into an infrastructure error, which is
 * what a check that cannot be made is (invariant 9).
 */
export function resolveWorldPath(state: Record<string, unknown>, path: string): WorldLookup {
	const segments = path.split(".");
	for (const segment of segments) {
		if (!WORLD_SEGMENT.test(segment)) {
			throw new Error(
				`world path ${JSON.stringify(path)} is a dotted path of [A-Za-z0-9_-] segments with no wildcards`,
			);
		}
		if (RESERVED_WORLD_SEGMENTS.has(segment)) {
			throw new Error(`world path ${JSON.stringify(path)} names the reserved property ${segment}`);
		}
	}
	let current: unknown = state;
	for (const segment of segments) {
		if (current === null || typeof current !== "object") return { found: false, value: undefined };
		if (Array.isArray(current)) {
			if (!/^[0-9]+$/.test(segment)) return { found: false, value: undefined };
			const index = Number(segment);
			if (!Number.isSafeInteger(index) || index >= current.length) return { found: false, value: undefined };
			current = current[index];
			continue;
		}
		if (!Object.hasOwn(current, segment)) return { found: false, value: undefined };
		current = (current as Record<string, unknown>)[segment];
	}
	return { found: true, value: current };
}

/**
 * Whether one value contains another. `null` means the question does not apply
 * to this shape — a number contains nothing, and an object is asked about keys,
 * which are strings.
 */
function worldContains(actual: unknown, wanted: unknown): boolean | null {
	if (typeof actual === "string") return typeof wanted === "string" ? actual.includes(wanted) : null;
	if (Array.isArray(actual)) return actual.some((item) => canonicalJson(item) === canonicalJson(wanted));
	if (actual !== null && typeof actual === "object") {
		return typeof wanted === "string" ? Object.hasOwn(actual, wanted) : null;
	}
	return null;
}

/** One expectation's verdict, and the sentence that says why in the evidence. */
export interface WorldExpectationVerdict {
	passed: boolean;
	reason: string;
}

/**
 * Decide one expectation against a finished world state.
 *
 * `equals` compares canonical JSON, so `{a:1,b:2}` and `{b:2,a:1}` are the same
 * value and `1` and `"1"` are not. `exists` is defined and not null — a field
 * explicitly set to null is a field the agent did not fill in. `contains` is
 * substring for a string, membership for an array, and key presence for an
 * object.
 */
export function evaluateWorldExpectation(
	state: Record<string, unknown>,
	expectation: WorldExpectation,
): WorldExpectationVerdict {
	const found = resolveWorldPath(state, expectation.path);
	const at = `world at ${expectation.path}`;
	if (expectation.op === "exists") {
		return found.found && found.value !== undefined && found.value !== null
			? { passed: true, reason: `${at} is set` }
			: { passed: false, reason: `${at} is not set` };
	}
	if (!found.found) {
		return { passed: false, reason: `${at} is not set, expected ${expectation.op} ${shown(expectation.value)}` };
	}
	if (expectation.op === "equals") {
		return canonicalJson(found.value) === canonicalJson(expectation.value)
			? { passed: true, reason: `${at} equals ${shown(expectation.value)}` }
			: {
				passed: false,
				reason: `${at} is ${shown(found.value)}, expected ${shown(expectation.value)}`,
			};
	}
	const held = worldContains(found.value, expectation.value);
	if (held === null) {
		return {
			passed: false,
			reason: `${at} is ${shown(found.value)}, which cannot contain ${shown(expectation.value)}`,
		};
	}
	return held
		? { passed: true, reason: `${at} contains ${shown(expectation.value)}` }
		: { passed: false, reason: `${at} does not contain ${shown(expectation.value)}` };
}

function readWorldBytes(path: string): Buffer {
	let entry;
	try {
		entry = lstatSync(path);
	} catch (error) {
		throw new Error(`world state file cannot be read: ${path}`, { cause: error });
	}
	if (entry.isSymbolicLink() || !entry.isFile()) {
		throw new Error(`world state file must be a regular non-symlink file: ${path}`);
	}
	if (entry.size > MAX_WORLD_BYTES) {
		throw new Error(`world state file is ${entry.size} bytes, over the ${MAX_WORLD_BYTES} byte bound: ${path}`);
	}
	let descriptor: number;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		throw new Error(`world state file cannot be read: ${path}`, { cause: error });
	}
	try {
		const opened = fstatSync(descriptor);
		if (!opened.isFile()) throw new Error(`world state file must be a regular non-symlink file: ${path}`);
		if (opened.size > MAX_WORLD_BYTES) {
			throw new Error(`world state file is ${opened.size} bytes, over the ${MAX_WORLD_BYTES} byte bound: ${path}`);
		}
		return readFileSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

/**
 * Read the world a run left behind.
 *
 * Every bound is the manifest's own: the byte bound, the nesting depth and the
 * reserved key names are checked by re-parsing through `WorldSchema`, so a
 * state a tool wrote and a state an author wrote are admitted by identical
 * rules. Anything this refuses THROWS — a world nobody can read says nothing
 * about the agent, and grading turns that into an infrastructure error rather
 * than a behavioural failure.
 */
export function readWorldStateFile(path: string): World["state"] {
	const bytes = readWorldBytes(path);
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (error) {
		throw new Error(`world state file is not valid UTF-8: ${path}`, { cause: error });
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new Error(`world state file is not JSON: ${path}`, { cause: error });
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`world state file must be a JSON object: ${path}`);
	}
	// `JSON.parse` defines a literal `__proto__` as an own property rather than
	// invoking the setter, so the manifest's raw-value guard sees it here too.
	const result = WorldSchema.safeParse({ state: parsed });
	if (!result.success) {
		const issues = result.error.issues.map((issue) => issue.message).join("; ");
		throw new Error(`world state file is not a valid world: ${path}: ${issues}`);
	}
	return result.data.state;
}
