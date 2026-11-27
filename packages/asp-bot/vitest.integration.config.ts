import { defineConfig } from "vitest/config"
import { sharedTest } from "../../vitest.base"

export default defineConfig({
	test: {
		...sharedTest,
		environment: "node",
		include: ["test/integration/**/*.integration.test.ts"],
		fileParallelism: false,
		testTimeout: 900_000,
		hookTimeout: 900_000,
	},
})
