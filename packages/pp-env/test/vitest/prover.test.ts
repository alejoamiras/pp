import { createProver } from "@pp/pool-client"
import { expect, test } from "vitest"
import { createProofService } from "../../src/client/prover.ts"

// vite's module runner builds its own `import.meta`, so a Bun-only field read there is undefined.
test("the single-thread curve loads under vite's module runner", async () => {
	expect(createProofService("unused")).toBeDefined()
	const slot = globalThis as { curve_bn128?: unknown }
	slot.curve_bn128 = undefined
	await createProver()
		.verify({} as never, [], {} as never)
		.catch(() => undefined)
	expect(slot.curve_bn128).toBeTruthy()
}, 60_000)
