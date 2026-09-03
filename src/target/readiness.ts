import type { ResolvedTarget } from "../manifest.js";
import { STARTER_MODEL_ID, standInManifestFields } from "./placeholders.js";

export const STARTER_TARGET_ID = "my-agent";
// The starter model id lives in `placeholders.ts` — `isStandInModel` needs it
// and this module already imports that one. Re-exported so every reader that
// learned the name here keeps it.
export { STARTER_MODEL_ID };

/**
 * Whether this manifest is still a template's starting material rather than a
 * configured agent. Two shapes say so, and both mean "nobody has chosen yet":
 * the built-in scaffold's exact id/model, and any template that still writes
 * `REPLACE-ME` where the identity or the model belongs. Every surface that
 * offers to configure the Target asks this one question.
 */
export function targetBootstrapRequired(
	manifest: Pick<ResolvedTarget["manifest"], "id" | "model">,
): boolean {
	return manifest.id === STARTER_TARGET_ID ||
		manifest.model.id === STARTER_MODEL_ID ||
		standInManifestFields(manifest).length > 0;
}

export interface TargetReadiness {
	ready: boolean;
	bootstrapRequired: boolean;
	credential: {
		environmentName: string;
		status: "missing" | "present-unverified";
	};
	issues: readonly string[];
}

/**
 * Honest, side-effect-free readiness for commands that would contact a model.
 * A present credential is deliberately not called "valid" or "authenticated":
 * only the provider can establish that after a request.
 */
export function inspectTargetReadiness(
	target: Pick<ResolvedTarget, "manifest">,
	environment: NodeJS.ProcessEnv = process.env,
): TargetReadiness {
	const bootstrapRequired = targetBootstrapRequired(target.manifest);
	const environmentName = target.manifest.model.apiKeyEnv;
	const credentialPresent = Boolean(environment[environmentName]?.trim());
	const issues: string[] = [];
	if (bootstrapRequired) {
		issues.push("Target identity and model still contain starter placeholders.");
	}
	if (!credentialPresent) {
		issues.push(`${environmentName} is not configured outside chat.`);
	}
	return {
		ready: issues.length === 0,
		bootstrapRequired,
		credential: {
			environmentName,
			status: credentialPresent ? "present-unverified" : "missing",
		},
		issues,
	};
}

export interface ToolCredentialReadinessLine {
	tool: string;
	environmentName: string;
	present: boolean;
	line: string;
}

/**
 * What `ahde validate` prints for every key a declared tool says it needs.
 *
 * A tool credential fails the same way a judge credential does — inside a
 * sandbox, at the first call, as whatever the tool's own code prints — unless
 * it is stated here beside the model keys. The value is never read: only
 * whether something non-empty is exported under that name.
 */
export function toolCredentialReadiness(
	target: Pick<ResolvedTarget, "tools">,
	environment: NodeJS.ProcessEnv = process.env,
): ToolCredentialReadinessLine[] {
	const lines: ToolCredentialReadinessLine[] = [];
	for (const tool of target.tools) {
		for (const environmentName of tool.descriptor.permissions.environment) {
			const present = Boolean(environment[environmentName]?.trim());
			lines.push({
				tool: tool.descriptor.name,
				environmentName,
				present,
				line: `tool ${tool.descriptor.name}: key ${environmentName} ${present ? "set" : "MISSING"}`,
			});
		}
	}
	return lines;
}

export function assertTargetReadyToRun(
	target: Pick<ResolvedTarget, "manifest">,
	environment: NodeJS.ProcessEnv = process.env,
): TargetReadiness {
	const readiness = inspectTargetReadiness(target, environment);
	if (!readiness.ready) {
		throw new Error(`Target is not ready to run: ${readiness.issues.join(" ")}`);
	}
	return readiness;
}
