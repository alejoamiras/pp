import { defineConfig } from "vitest/config"

/** A run whose only failure is a global teardown that finds leftovers. */
export default defineConfig({
	test: { root: import.meta.dirname, include: ["pass.check.ts"], globalSetup: ["./global-setup.ts"] },
})
