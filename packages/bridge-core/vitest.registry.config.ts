import { defineConfig } from "vitest/config"
import { sharedTest } from "../../vitest.base"

/*
 * The ASP registry on a live local network: real anchors, a real public phase and the node's expiry
 * check, which TXE cannot show. Runs only from this config (`test:registry`); neither the unit nor
 * the bridge integration config collects it.
 */
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
