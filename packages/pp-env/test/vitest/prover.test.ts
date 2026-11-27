import { expect, test } from "vitest"
import { createProofService } from "../../src/client/prover.ts"
import { checkout } from "../../src/env/checkout.ts"

// Schema-valid, so verification reaches the prover, and false.
const unverifiable = {
	proof: {
		pi_a: ["0x1", "0x2", "0x1"],
		pi_b: [
			["0x1", "0x2"],
			["0x3", "0x4"],
			["0x1", "0x0"],
		],
		pi_c: ["0x1", "0x2", "0x1"],
		protocol: "groth16",
		curve: "bn128",
	},
	publicSignals: ["0x1"],
} as const

// vite's module runner builds its own `import.meta`, so a Bun-only field read there is undefined.
test("a deposit verifies on the single-thread curve under vite's module runner", async () => {
	const slot = globalThis as { curve_bn128?: unknown }
	slot.curve_bn128 = undefined
	await createProofService({ circuitsDir: checkout().circuits, chainId: 31_337 })
		.verifyDeposit(unverifiable as never)
		.catch(() => undefined)
	expect(slot.curve_bn128).toBeTruthy()
}, 60_000)
