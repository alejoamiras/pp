import { defineConfig } from "vitest/config"
import { sharedTest } from "../../vitest.base"

/*
 * The bridge's suite against one running local stack, attached through PP_STACK_MANIFEST only: it
 * never boots or mines (`scripts/with-stack.ts` boots one around it). Sequential: the files share
 * one chain, and every wait is sized from the stack's proof-gated beats.
 */
export default defineConfig({
	test: {
		...sharedTest,
		globals: true,
		environment: "node",
		include: ["test/integration/stack/**/*.stack.test.ts"],
		globalSetup: ["./test/integration/stack/global-setup.ts"],
		fileParallelism: false,
		testTimeout: 600_000,
		hookTimeout: 600_000,
		reporters: ["verbose"],
	},
})
