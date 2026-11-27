import { defineConfig } from "vitest/config"
import { sharedTest } from "../../vitest.base"

// One anvil + local network for the whole run, booted by the global setup; files share it, so they
// run one at a time. Runs only from this config (`test:net`); the everyday `test` excludes it.
export default defineConfig({
	test: {
		...sharedTest,
		environment: "node",
		include: ["test/net/**/*.test.ts"],
		globalSetup: ["./test/net/global-setup.ts"],
		fileParallelism: false,
		testTimeout: 900_000,
		hookTimeout: 900_000,
		reporters: ["verbose"],
		// Under Bun, this global setup loads @pp/bridge-core as a dependency and gets zod's default in
		// place of its namespace, so `z` is missing: vitest.base.ts's stopgap does not reach it, and
		// bridge-core's own suite, which loads the same files as source, is unaffected. Inlined, vite
		// transforms zod itself.
		server: { deps: { inline: ["zod"] } },
	},
})
