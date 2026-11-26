import { defineConfig } from "vitest/config"
import { sharedTest } from "../../vitest.base"

/* Each file boots its own stacks; one file at a time leaves a CI runner's cores to the node. */
export default defineConfig({
	test: {
		...sharedTest,
		environment: "node",
		include: ["test/integration/**/*.integration.test.ts"],
		fileParallelism: false,
		testTimeout: 1_800_000,
		hookTimeout: 600_000,
		reporters: ["verbose"],
		// pp-env resolves `@ppv2/*` through its tsconfig paths, which only Bun's own loader reads.
		server: { deps: { external: [/\/packages\/pp-env\//] } },
	},
})
