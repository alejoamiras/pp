import { defineConfig } from "vitest/config"
import { sharedTest } from "../../vitest.base"

// What TXE cannot show: a proof's anchor older than the state its public phase meets, and the
// node's expiry check.
export default defineConfig({
	test: {
		...sharedTest,
		globals: true,
		environment: "node",
		include: ["test/integration/registry/**/*.network.test.ts"],
		globalSetup: ["./test/integration/registry/global-setup.ts"],
		fileParallelism: false,
		testTimeout: 600_000,
		hookTimeout: 600_000,
		reporters: ["verbose"],
	},
})
