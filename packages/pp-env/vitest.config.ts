import { defineConfig } from "vitest/config"
import { sharedTest } from "../../vitest.base"

/* Only what must hold under vite's module runner, as every vitest or vite consumer loads pp-env; the rest runs on `bun test`. */
export default defineConfig({
	test: {
		...sharedTest,
		environment: "node",
		include: ["test/vitest/**/*.test.ts"],
	},
})
