import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		// Vitest's agent reporter hides passing tests' console, which carries the measured proof times.
		reporters: ["default"],
		projects: [
			{ test: { name: "unit", include: ["test/unit/**/*.test.ts"], testTimeout: 10_000 } },
			{ test: { name: "proof", include: ["test/proof/**/*.test.ts"], testTimeout: 60_000, hookTimeout: 60_000 } },
		],
	},
})
