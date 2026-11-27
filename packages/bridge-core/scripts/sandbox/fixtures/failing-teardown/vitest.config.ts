import { defineConfig } from "vitest/config"

/** A run whose only failure is its global teardown (see global-setup.ts for the cases). */
export default defineConfig({
	test: { root: import.meta.dirname, include: ["pass.check.ts"], globalSetup: ["./global-setup.ts"] },
})
