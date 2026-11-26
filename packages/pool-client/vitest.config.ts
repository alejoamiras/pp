import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const checkout = fileURLToPath(new URL("../pp-env/.ppv2", import.meta.url))

export default defineConfig({
	test: {
		// Vitest's agent reporter hides passing tests' console, which carries the measured proof times.
		reporters: ["default"],
		projects: [
			{ test: { name: "unit", include: ["test/unit/**/*.test.ts"], testTimeout: 10_000 } },
			{
				// The checkout's sample app imports `APP_IDENTIFIER` from its own SDK, served here from the checkout's
				// constants source (the whole SDK build does not load under Bun's vitest), and a bare `viem`.
				resolve: {
					alias: [
						{
							find: "@privacy-pools-v2/evm-sdk",
							replacement: join(checkout, "packages/core-sdk/src/constant/KeyDerivation.ts"),
						},
						{ find: /^viem$/, replacement: fileURLToPath(new URL("./node_modules/viem", import.meta.url)) },
					],
				},
				test: { name: "proof", include: ["test/proof/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 60_000 },
			},
			{
				test: {
					name: "integration",
					include: ["test/integration/**/*.test.ts"],
					globalSetup: ["test/integration/global-setup.ts"],
					testTimeout: 120_000,
					hookTimeout: 240_000,
					fileParallelism: false,
				},
			},
		],
	},
})
