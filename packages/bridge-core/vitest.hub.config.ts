import { defineConfig } from "vitest/config"
import { sharedTest } from "../../vitest.base"

/*
 * The hub's local-network suite: one anvil + `aztec start --local-network` that this run boots and
 * owns, the hub and its token deployed by the tests themselves, and blocks mined only by the tests.
 * Sequential: the cases share one chain and count its blocks.
 */
export default defineConfig({
	test: {
		...sharedTest,
		globals: true,
		environment: "node",
		include: ["test/integration/hub/**/*.network.test.ts"],
		globalSetup: ["./test/integration/hub/global-setup.ts"],
		fileParallelism: false,
		testTimeout: 600_000,
		hookTimeout: 600_000,
		reporters: ["verbose"],
	},
})
