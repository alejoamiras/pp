import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		globalSetup: ["./test/global-setup.ts"],
		// One network serves every file, and the files share its chain: run them one at a time.
		fileParallelism: false,
		testTimeout: 900_000,
		hookTimeout: 900_000,
		reporters: ["verbose"],
		// Bun's ESM namespaces answer `"__esModule" in ns`, which makes vitest 4's default interop drop named exports.
		deps: { interopDefault: false },
	},
})
