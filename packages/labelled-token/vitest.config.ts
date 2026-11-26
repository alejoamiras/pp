import { defineConfig } from "vitest/config"
import { sharedTest } from "../../vitest.base"

export default defineConfig({
	test: {
		...sharedTest,
		environment: "node",
		// The network suites boot a local network; they run from their own config only.
		exclude: ["node_modules", "test/net/**"],
	},
})
