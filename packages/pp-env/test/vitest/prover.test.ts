import { expect, test } from "vitest"
import { singleThreadProver } from "../../src/client/prover.ts"

// vite's module runner builds its own `import.meta`, so a Bun-only field read there is undefined.
test("the single-thread curve loads under vite's module runner", async () => {
	const inner = { fullProve: () => Promise.reject(new Error("unused")), verify: () => Promise.resolve(true) }
	await expect(singleThreadProver(inner).verify({} as never, [], {} as never)).resolves.toBe(true)
}, 60_000)
