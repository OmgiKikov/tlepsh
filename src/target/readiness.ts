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
