import { defineConfig } from "vitest/config"
import { sharedTest } from "../../vitest.base"

export default defineConfig({
	test: {
		...sharedTest,
		// @aztec-labs/foundation registers equality testers on the global `expect` when it loads.
		globals: true,
		environment: "node",
	},
})
