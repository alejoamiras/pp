import { describe, expect, test } from "vitest"

// Loading pp-env needs its fetched checkout, so this runs only with the integration flag.
describe.skipIf(!process.env.PP_STACK_INTEGRATION)("harness imports", () => {
	test("both harnesses load in one process", async () => {
		const [pool, sandbox] = await Promise.all([import("@pp/pp-env"), import("@pp/bridge-core/sandbox")])
		expect(typeof pool.startPoolEnv).toBe("function")
		expect(typeof sandbox.startLocalNetwork).toBe("function")
	})
})
