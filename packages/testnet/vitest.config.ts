import { defineConfig } from "vitest/config"
import { sharedTest } from "../../vitest.base"

export default defineConfig({
	test: {
		...sharedTest,
		environment: "node",
		exclude: ["test/**", "**/node_modules/**"],
		// CI's `test:all` runs every workspace's pool on one small runner; two workers keep this suite's
		// CLI spawns from pushing other suites past their timeouts, for under 10 s of its own wall-clock.
		maxWorkers: process.env.CI ? 2 : undefined,
	},
})
