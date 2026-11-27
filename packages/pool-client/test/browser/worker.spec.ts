import { expect, test } from "@playwright/test"
import { fenceEachTest, openProbe, probe } from "./probe.ts"

fenceEachTest()

test("proving in a worker never stalls the main thread for 100 ms", async ({ page }) => {
	await openProbe(page)
	// Worker first: each snarkjs curve starts a thread per core (up to 64), each reserving wasm memory, and two
	// live curves in one renderer exhaust its wasm address space on a many-core host. The worker's dies with it.
	const worker = await probe(page).prove("/ipfs", "worker")
	const main = await probe(page).prove("/ipfs", "main")
	console.log(
		`[pool-client] longest main-thread stall during a prove: ${Math.round(main.maxStallMs)} ms on the main thread, ` +
			`${Math.round(worker.maxStallMs)} ms with the worker (prove ${Math.round(worker.proveMs)} ms)`,
	)
	expect(worker.verified).toBe(true)
	expect(worker.signals).toEqual(main.signals)
	expect(worker.maxStallMs).toBeLessThan(100)
})
