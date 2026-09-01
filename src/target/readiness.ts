import type { ResolvedTarget } from "../manifest.js";

export const STARTER_TARGET_ID = "my-agent";
export const STARTER_MODEL_ID = "replace-with-model-id";

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
	const bootstrapRequired =
		target.manifest.id === STARTER_TARGET_ID ||
		target.manifest.model.id === STARTER_MODEL_ID;
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
