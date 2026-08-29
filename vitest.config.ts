import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		testTimeout: 120_000,
		// Cycle fixtures drive a real Workbench through Git; a loaded machine must not flake them.
		hookTimeout: 120_000,
	},
});
