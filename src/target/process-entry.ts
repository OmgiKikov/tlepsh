import { loadTarget } from "../manifest.js";
import {
	assertInteractiveTargetIdentity,
	runInteractiveTargetProcess,
	type InteractiveTargetProcessLaunch,
} from "./interactive.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertLaunchPayload(value: unknown): asserts value is InteractiveTargetProcessLaunch {
	if (!isRecord(value) || value.protocol !== 1) {
		throw new Error("interactive Target child received an unsupported IPC launch payload");
	}
	if (
		typeof value.targetDir !== "string" ||
		!isRecord(value.targetIdentity) ||
		!isRecord(value.workspaceSnapshot) ||
		typeof value.workspaceSnapshot.dir !== "string" ||
		typeof value.workspaceSnapshot.sha256 !== "string" ||
		!isRecord(value.environment) ||
		(value.initialMessage !== undefined && typeof value.initialMessage !== "string")
	) {
		throw new Error("interactive Target child received a malformed IPC launch payload");
	}
	for (const [name, environmentValue] of Object.entries(value.environment)) {
		if (typeof environmentValue !== "string") {
			throw new Error(`interactive Target child received a non-string environment value for ${name}`);
		}
	}
}

function assertLoaderSafeBootstrapEnvironment(): void {
	const dangerous = Object.keys(process.env).find((name) =>
		name === "NODE_OPTIONS" ||
		name === "LD_PRELOAD" ||
		name === "LD_AUDIT" ||
		name.startsWith("DYLD_"),
	);
	if (dangerous) {
		throw new Error(`interactive Target child refused loader environment ${dangerous}`);
	}
}

function receiveLaunch(): Promise<InteractiveTargetProcessLaunch> {
	if (typeof process.send !== "function") {
		throw new Error("interactive Target process requires a private IPC channel");
	}
	return new Promise((resolvePromise, reject) => {
		const onDisconnect = (): void => {
			process.off("message", onMessage);
			reject(new Error("interactive Target parent disconnected before launch"));
		};
		const onMessage = (value: unknown): void => {
			process.off("disconnect", onDisconnect);
			try {
				assertLaunchPayload(value);
				resolvePromise(value);
			} catch (error) {
				reject(error);
			}
		};
		process.once("disconnect", onDisconnect);
		process.once("message", onMessage);
	});
}

assertLoaderSafeBootstrapEnvironment();
const launch = await receiveLaunch();
process.disconnect?.();

const target = loadTarget(launch.targetDir);
assertInteractiveTargetIdentity(launch.targetIdentity, target);
await runInteractiveTargetProcess(target, {
	...(launch.initialMessage !== undefined ? { initialMessage: launch.initialMessage } : {}),
	environment: { ...launch.environment },
	workspaceSnapshot: launch.workspaceSnapshot,
});
