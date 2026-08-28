import { resolve } from "node:path";

/** Resolve the interactive Target selected by the CLI. */
export function resolveInteractiveTargetDirectory(
	targetArgument: string | undefined,
	invocationDirectory = process.cwd(),
): string {
	return resolve(invocationDirectory, targetArgument ?? ".");
}
