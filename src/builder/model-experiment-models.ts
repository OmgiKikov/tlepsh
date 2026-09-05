import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	resolveTargetModelSelection,
	TargetModelSelectionSchema,
	type TargetModelSelection,
} from "../application/target-model-selection.js";
import type { TargetManifest } from "../manifest.js";
import { canonicalJson } from "../provenance.js";
import { hostModelCatalog, selectTargetCredentialEnvironment, type HostModelCatalog } from "./onboarding.js";

/** Declared prices guide selection; only recorded runs can establish savings. */
export function modelExperimentCatalog(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	currentProvider?: string,
): HostModelCatalog {
	const all = hostModelCatalog(ctx, { limit: Number.POSITIVE_INFINITY });
	const models = all.models.map((entry) => {
		let metadata;
		try { metadata = ctx.modelRegistry.find(entry.provider, entry.modelId); } catch { metadata = undefined; }
		const cost = metadata?.cost;
		const values = cost ? [cost.input, cost.output, cost.cacheRead, cost.cacheWrite] : [];
		const knownPrice = values.length === 4 && values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0) && values.some((value) => value > 0);
		return {
			...entry,
			declaredCostUsdPerMillionTokens: knownPrice && cost ? { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite } : null,
			pricing: knownPrice ? "declared-catalog-rate" : "unknown-or-ambiguous-zero",
			reasoning: typeof metadata?.reasoning === "boolean" ? metadata.reasoning : null,
			contextWindow: typeof metadata?.contextWindow === "number" && Number.isFinite(metadata.contextWindow) && metadata.contextWindow > 0 ? metadata.contextWindow : null,
		};
	});
	models.sort((left, right) => {
		const availability = Number(right.credentialPresent) - Number(left.credentialPresent);
		if (availability) return availability;
		const provider = Number(right.provider === currentProvider) - Number(left.provider === currentProvider);
		if (provider) return provider;
		const rate = (entry: typeof left) => entry.declaredCostUsdPerMillionTokens
			? entry.declaredCostUsdPerMillionTokens.input + entry.declaredCostUsdPerMillionTokens.output : Number.POSITIVE_INFINITY;
		const leftRate = rate(left);
		const rightRate = rate(right);
		return leftRate === rightRate ? 0 : leftRate - rightRate;
	});
	return { models: models.slice(0, 40), omittedModels: Math.max(0, models.length - 40) };
}

/** Freeze the catalog and host-owned credentials for this exact experiment. */
export async function modelExperimentResolver(
	ctx: Pick<ExtensionContext, "modelRegistry" | "ui">,
	selections: readonly TargetModelSelection[],
	current: { provider: string; apiKeyEnv: string } | null | undefined,
	signal?: AbortSignal,
): Promise<(selection: TargetModelSelection) => TargetManifest["model"]> {
	signal?.throwIfAborted();
	// Check every choice before asking anything. Detach catalog metadata before
	// the operator can change native model settings during a credential dialog.
	const requested = selections.map((input) => {
		const selection = TargetModelSelectionSchema.parse(input);
		const model = ctx.modelRegistry.find(selection.provider, selection.modelId);
		if (!model) throw new Error(`Target model ${selection.provider}/${selection.modelId} is not available in the trusted host catalog`);
		return { selection, model: structuredClone(model) };
	});
	const credentials = new Map<string, string>();
	if (current && process.env[current.apiKeyEnv]?.trim()) credentials.set(current.provider, current.apiKeyEnv);
	const resolved = new Map<string, TargetManifest["model"]>();
	for (const { selection, model } of requested) {
		signal?.throwIfAborted();
		let apiKeyEnv = credentials.get(selection.provider);
		if (!apiKeyEnv) {
			apiKeyEnv = await selectTargetCredentialEnvironment(ctx, selection, undefined, signal);
			credentials.set(selection.provider, apiKeyEnv);
		}
		resolved.set(canonicalJson(selection), resolveTargetModelSelection(selection, model, { apiKeyEnv }));
	}
	return (input) => {
		signal?.throwIfAborted();
		const model = resolved.get(canonicalJson(TargetModelSelectionSchema.parse(input)));
		if (!model) throw new Error("The host did not resolve this selection for the model experiment");
		return structuredClone(model);
	};
}
