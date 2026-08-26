import { z } from "zod";
import { TargetManifest } from "./manifest.js";

/** Optional model/instruction profile used by one-shot compatibility Builder adapters. */

export const BuilderManifest = z.strictObject({
	id: z.string().min(1),
	/**
	 * Frontier model for the builder. Optional: when omitted the builder
	 * inherits the target's model (one-place config for experiments).
	 * Production builders should declare an explicit frontier model.
	 */
	model: TargetManifest.shape.model.optional(),
	instructions: z.strictObject({
		agentsMd: z.string().min(1),
	}),
	skills: z.array(z.string().min(1)).default([]),
});
export type BuilderManifest = z.infer<typeof BuilderManifest>;
