import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { z } from "zod";
import {
	ModelBlock,
	ThinkingLevel,
	type TargetManifest as TargetManifestValue,
} from "../manifest.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 3_600_000;
const MAX_SELECTION_BYTES = 32 * 1024;
const MAX_COMPAT_BYTES = 64 * 1024;
const MAX_METADATA_DEPTH = 8;
const MAX_METADATA_NODES = 512;
const MAX_OBJECT_KEYS = 64;
const MAX_STRING_BYTES = 16 * 1024;

const IdentitySchema = z.string()
	.min(1)
	.max(512)
	.refine((value) => value.trim() === value, "must not have leading or trailing whitespace")
	.refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must not contain control characters");

const EnvironmentNameSchema = z.string()
	.min(1)
	.max(200)
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name");

export const TargetModelSelectionSchema = z.strictObject({
	provider: IdentitySchema,
	modelId: IdentitySchema,
	thinkingLevel: ThinkingLevel.optional(),
	timeoutMs: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).optional(),
	params: z.record(z.string(), z.unknown()).optional(),
});

const CostTierSchema = z.strictObject({
	inputTokensAbove: z.number().int().nonnegative().max(100_000_000),
	input: z.number().finite().nonnegative().max(1_000_000),
	output: z.number().finite().nonnegative().max(1_000_000),
	cacheRead: z.number().finite().nonnegative().max(1_000_000),
	cacheWrite: z.number().finite().nonnegative().max(1_000_000),
});

const CostSchema = z.strictObject({
	input: z.number().finite().nonnegative().max(1_000_000),
	output: z.number().finite().nonnegative().max(1_000_000),
	cacheRead: z.number().finite().nonnegative().max(1_000_000),
	cacheWrite: z.number().finite().nonnegative().max(1_000_000),
	tiers: z.array(CostTierSchema).max(32).optional(),
});

const ThinkingLevelMapSchema = z.strictObject({
	off: z.string().min(1).max(100).nullable().optional(),
	minimal: z.string().min(1).max(100).nullable().optional(),
	low: z.string().min(1).max(100).nullable().optional(),
	medium: z.string().min(1).max(100).nullable().optional(),
	high: z.string().min(1).max(100).nullable().optional(),
	xhigh: z.string().min(1).max(100).nullable().optional(),
	max: z.string().min(1).max(100).nullable().optional(),
});

const RESERVED_REQUEST_PARAMS = new Set([
	"contents",
	"input",
	"instructions",
	"messages",
	"model",
	"prompt",
	"stream",
	"system",
	"systeminstruction",
	"toolchoice",
	"tools",
]);

const CREDENTIAL_KEYS = new Set([
	"apikey",
	"accesstoken",
	"authorization",
	"authtoken",
	"bearertoken",
	"clientsecret",
	"credential",
	"credentials",
	"key",
	"password",
	"passwd",
	"privatekey",
	"refreshtoken",
	"secret",
	"secretkey",
	"token",
]);

type JsonData = null | boolean | number | string | JsonData[] | { [key: string]: JsonData };

interface MetadataBudget {
	nodes: number;
	readonly ancestors: WeakSet<object>;
}

/** Builder-owned, non-secret choices. Execution metadata comes from the exact host model. */
export type TargetModelSelection = z.infer<typeof TargetModelSelectionSchema>;

export interface ResolveTargetModelSelectionOptions {
	/** Host-owned credential reference. It is never accepted from Builder model input. */
	apiKeyEnv: string;
}

function normalizedKey(key: string): string {
	return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function looksLikeCredentialKey(key: string): boolean {
	const normalized = normalizedKey(key);
	return CREDENTIAL_KEYS.has(normalized) ||
		/(?:api|access|refresh|auth|bearer|client|private|secret)(?:key|token|secret|credential)s?$/.test(normalized);
}

function looksLikeSecretValue(value: string): boolean {
	return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(value) ||
		/(?:^|\s)Bearer\s+[A-Za-z0-9._~+/=-]{8,}(?:$|\s)/i.test(value) ||
		/(?:^|[^A-Za-z0-9_-])(?:sk|rk)-(?:proj-)?[A-Za-z0-9_-]{12,}(?:$|[^A-Za-z0-9_-])/i.test(value) ||
		/(?:^|[^A-Za-z0-9_])(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{12,}(?:$|[^A-Za-z0-9_])/i.test(value) ||
		/(?:^|[^0-9A-Z])AKIA[0-9A-Z]{16}(?:$|[^0-9A-Z])/.test(value) ||
		/(?:^|[^0-9A-Za-z_-])AIza[0-9A-Za-z_-]{20,}(?:$|[^0-9A-Za-z_-])/.test(value) ||
		/(?:^|\s)eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:$|\s)/.test(value);
}

function normalizeMetadataValue(
	value: unknown,
	path: string,
	depth: number,
	budget: MetadataBudget,
): JsonData {
	budget.nodes += 1;
	if (budget.nodes > MAX_METADATA_NODES) throw new Error(`${path} exceeds the metadata node limit`);
	if (depth > MAX_METADATA_DEPTH) throw new Error(`${path} exceeds the metadata depth limit`);

	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite numbers`);
		return value;
	}
	if (typeof value === "string") {
		if (Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES) throw new Error(`${path} contains an oversized string`);
		if (looksLikeSecretValue(value)) throw new Error(`${path} contains a credential-looking value`);
		return value;
	}
	if (typeof value !== "object") throw new Error(`${path} must contain only JSON data`);

	if (budget.ancestors.has(value)) throw new Error(`${path} contains a cycle`);
	budget.ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (value.length > MAX_OBJECT_KEYS) throw new Error(`${path} exceeds the array item limit`);
			return value.map((item, index) => normalizeMetadataValue(item, `${path}[${index}]`, depth + 1, budget));
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must be a plain object`);
		const ownKeys = Reflect.ownKeys(value);
		if (ownKeys.some((key) => typeof key === "symbol")) throw new Error(`${path} cannot contain symbol keys`);
		if (ownKeys.length > MAX_OBJECT_KEYS) throw new Error(`${path} exceeds the object key limit`);

		const normalized: Record<string, JsonData> = {};
		for (const key of (ownKeys as string[]).sort()) {
			if (key.length === 0 || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) {
				throw new Error(`${path} contains an invalid metadata key`);
			}
			if (["__proto__", "constructor", "prototype"].includes(key)) {
				throw new Error(`${path}.${key} is an unsafe metadata key`);
			}
			if (looksLikeCredentialKey(key)) throw new Error(`${path}.${key} is a credential-looking key`);
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor?.enumerable || !("value" in descriptor)) {
				throw new Error(`${path}.${key} must be an enumerable data property`);
			}
			normalized[key] = normalizeMetadataValue(descriptor.value, `${path}.${key}`, depth + 1, budget);
		}
		return normalized;
	} finally {
		budget.ancestors.delete(value);
	}
}

function normalizeMetadata(value: unknown, path: string, maxBytes: number): JsonData {
	const normalized = normalizeMetadataValue(value, path, 0, {
		nodes: 0,
		ancestors: new WeakSet(),
	});
	const encoded = JSON.stringify(normalized);
	if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw new Error(`${path} exceeds ${maxBytes} encoded bytes`);
	return normalized;
}

function normalizedRecord(value: unknown, path: string, maxBytes: number): Record<string, unknown> {
	const normalized = normalizeMetadata(value, path, maxBytes);
	if (normalized === null || Array.isArray(normalized) || typeof normalized !== "object") {
		throw new Error(`${path} must be a plain object`);
	}
	return normalized;
}

function dataRecord(value: unknown, path: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${path} must be a plain object`);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must be a plain object`);
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key === "symbol") throw new Error(`${path} cannot contain symbol keys`);
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable || !("value" in descriptor)) {
			throw new Error(`${path}.${key} must be an enumerable data property`);
		}
	}
	return value as Record<string, unknown>;
}

function hostIdentity(value: unknown, label: string): string {
	const parsed = IdentitySchema.safeParse(value);
	if (!parsed.success) throw new Error(`${label} is invalid`, { cause: parsed.error });
	return parsed.data;
}

function hostBaseUrl(value: unknown): string {
	const baseUrl = z.string().min(1).max(2_048).parse(value);
	if (/[\u0000-\u001f\u007f]/.test(baseUrl)) throw new Error("resolved model baseUrl contains control characters");
	if (looksLikeSecretValue(baseUrl)) throw new Error("resolved model baseUrl contains a credential-looking value");
	let endpoint: URL;
	try {
		endpoint = new URL(baseUrl);
	} catch (error) {
		throw new Error("resolved model baseUrl is not a valid URL", { cause: error });
	}
	if (!new Set(["http:", "https:"]).has(endpoint.protocol) || endpoint.hostname.length === 0) {
		throw new Error("resolved model baseUrl must use HTTP or HTTPS");
	}
	if (endpoint.username || endpoint.password) throw new Error("resolved model baseUrl cannot contain credentials");
	if (endpoint.hash) throw new Error("resolved model baseUrl cannot contain a fragment");
	for (const [key, queryValue] of endpoint.searchParams) {
		if (looksLikeCredentialKey(key) || looksLikeSecretValue(queryValue)) {
			throw new Error("resolved model baseUrl cannot contain credential query parameters");
		}
	}
	return baseUrl;
}

function supportedThinkingLevels(
	reasoning: boolean,
	thinkingLevelMap: z.infer<typeof ThinkingLevelMapSchema> | undefined,
): ModelThinkingLevel[] {
	if (!reasoning) return ["off"];
	const levels: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	return levels.filter((level) => {
		const mapped = thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

function defaultThinkingLevel(levels: readonly ModelThinkingLevel[]): ModelThinkingLevel {
	const preferredOrder: readonly ModelThinkingLevel[] = ["medium", "high", "xhigh", "max", "low", "minimal", "off"];
	const selected = preferredOrder.find((level) => levels.includes(level));
	if (!selected) throw new Error("resolved model has no supported thinking level");
	return selected;
}

/**
 * Materialize a complete AHDE model definition from a tiny Builder selection and
 * one exact, host-resolved Pi catalog model. This function performs no I/O.
 */
export function resolveTargetModelSelection(
	selectionInput: unknown,
	resolvedModelInput: Model<Api>,
	options: ResolveTargetModelSelectionOptions,
): TargetManifestValue["model"] {
	const selectionData = normalizeMetadata(selectionInput, "selection", MAX_SELECTION_BYTES);
	const selection: TargetModelSelection = TargetModelSelectionSchema.parse(selectionData);
	const resolvedModel = dataRecord(resolvedModelInput, "resolved model");

	const provider = hostIdentity(resolvedModel.provider, "resolved model provider");
	const id = hostIdentity(resolvedModel.id, "resolved model id");
	const apiKeyEnv = EnvironmentNameSchema.parse(options.apiKeyEnv);
	if (selection.provider !== provider) throw new Error("selected provider does not match the host-resolved model");
	if (selection.modelId !== id) throw new Error("selected modelId does not match the host-resolved model");

	const api = hostIdentity(resolvedModel.api, "resolved model api");
	const baseUrl = hostBaseUrl(resolvedModel.baseUrl);
	const reasoning = z.boolean().parse(resolvedModel.reasoning);
	const input = z.array(z.enum(["text", "image"])).min(1).max(2)
		.refine((items) => new Set(items).size === items.length, "resolved model input modalities must be unique")
		.parse(normalizeMetadata(resolvedModel.input, "resolved model input", MAX_SELECTION_BYTES));
	const contextWindow = z.number().int().positive().max(100_000_000).parse(resolvedModel.contextWindow);
	const maxTokens = z.number().int().positive().max(100_000_000).parse(resolvedModel.maxTokens);
	const costData = normalizedRecord(resolvedModel.cost, "resolved model cost", MAX_SELECTION_BYTES);
	const cost = CostSchema.parse(costData);
	const tiers = cost.tiers
		? [...cost.tiers].sort((left, right) => left.inputTokensAbove - right.inputTokensAbove)
		: undefined;
	if (tiers && new Set(tiers.map((tier) => tier.inputTokensAbove)).size !== tiers.length) {
		throw new Error("resolved model cost tiers must have unique input thresholds");
	}
	if (resolvedModel.headers !== undefined) {
		const headers = normalizedRecord(resolvedModel.headers, "resolved model headers", MAX_SELECTION_BYTES);
		if (Object.keys(headers).length > 0) {
			throw new Error("resolved model requires custom headers that the Target runtime cannot preserve safely");
		}
	}
	const compat = resolvedModel.compat === undefined
		? {}
		: normalizedRecord(resolvedModel.compat, "resolved model compat", MAX_COMPAT_BYTES);
	const thinkingLevelMap = resolvedModel.thinkingLevelMap === undefined
		? undefined
		: ThinkingLevelMapSchema.parse(
			normalizedRecord(resolvedModel.thinkingLevelMap, "resolved model thinkingLevelMap", MAX_SELECTION_BYTES),
		);
	const supported = supportedThinkingLevels(reasoning, thinkingLevelMap);
	const thinkingLevel = selection.thinkingLevel ?? defaultThinkingLevel(supported);
	if (!supported.includes(thinkingLevel)) {
		throw new Error(`thinking level ${thinkingLevel} is not supported by the host-resolved model`);
	}

	const selectedParams = selection.params === undefined
		? {}
		: normalizedRecord(selection.params, "selection.params", MAX_SELECTION_BYTES);
	const hostSamplingParams = resolvedModel.samplingParams === undefined
		? {}
		: normalizedRecord(resolvedModel.samplingParams, "resolved model samplingParams", MAX_SELECTION_BYTES);
	const params = normalizedRecord(
		{ ...hostSamplingParams, ...selectedParams },
		"resolved model request params",
		MAX_SELECTION_BYTES,
	);
	for (const key of Object.keys(params)) {
		if (RESERVED_REQUEST_PARAMS.has(normalizedKey(key))) {
			throw new Error(`selection.params cannot override reserved request field ${JSON.stringify(key)}`);
		}
	}

	return ModelBlock.parse({
		provider,
		id,
		api,
		baseUrl,
		apiKeyEnv,
		thinkingLevel,
		timeoutMs: selection.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		params,
		spec: {
			reasoning,
			input,
			...(thinkingLevelMap ? { thinkingLevelMap } : {}),
			contextWindow,
			maxTokens,
			cost: {
				input: cost.input,
				output: cost.output,
				cacheRead: cost.cacheRead,
				cacheWrite: cost.cacheWrite,
				...(tiers ? { tiers } : {}),
			},
			compat,
		},
	});
}
