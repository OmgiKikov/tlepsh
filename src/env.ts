import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Dotenv loading with visible provenance.
 *
 * Precedence follows the dotenv convention: process env > .env.local > .env.
 * That convention silently bites when a stale key sits in the shell and a
 * fresh one sits in .env, so every load records where each variable came
 * from and flags conflicts. `ahde validate` surfaces this.
 */

export type EnvSource = "shell" | ".env.local" | ".env";

export interface EnvConflict {
	name: string;
	file: string;
	shellFingerprint: string;
	fileFingerprint: string;
}

export interface EnvReport {
	sources: Map<string, EnvSource>;
	conflicts: EnvConflict[];
}

/** Mask a secret: last 4 chars plus length. Never returns the full value. */
export function fingerprint(value: string | undefined): string {
	if (!value) return "(unset)";
	return `…${value.slice(-4)} (len ${value.length})`;
}

function parseLine(line: string): [string, string] | null {
	const stripped = line.replace(/^\s*export\s+/, "").trim();
	if (!stripped || stripped.startsWith("#")) return null;
	const match = stripped.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
	if (!match?.[1] || match[2] === undefined) return null;
	let value = match[2].trim();
	const quoted = value.match(/^(["'])([\s\S]*)\1$/);
	if (quoted?.[2] !== undefined) {
		value = quoted[2];
	} else {
		const commentIndex = value.indexOf(" #");
		if (commentIndex !== -1) value = value.slice(0, commentIndex).trim();
	}
	return [match[1], value];
}

export function loadDotEnv(cwd = process.cwd(), env: Record<string, string | undefined> = process.env): EnvReport {
	const sources = new Map<string, EnvSource>();
	const conflicts: EnvConflict[] = [];
	for (const file of [".env.local", ".env"] as const) {
		const path = resolve(cwd, file);
		if (!existsSync(path)) continue;
		for (const line of readFileSync(path, "utf8").split("\n")) {
			const parsed = parseLine(line);
			if (!parsed) continue;
			const [name, value] = parsed;
			const existing = env[name];
			if (existing === undefined) {
				env[name] = value;
				sources.set(name, file);
				continue;
			}
			const owner = sources.get(name);
			if (owner === undefined) {
				sources.set(name, "shell");
				if (existing !== value) {
					conflicts.push({
						name,
						file,
						shellFingerprint: fingerprint(existing),
						fileFingerprint: fingerprint(value),
					});
				}
			}
		}
	}
	return { sources, conflicts };
}

/** One-line human description of where a variable came from. */
export function describeEnvVar(name: string, report: EnvReport, env = process.env): string {
	const value = env[name];
	const source = report.sources.get(name) ?? (value === undefined ? "(unset)" : "shell");
	return `${fingerprint(value)} from ${source}`;
}
