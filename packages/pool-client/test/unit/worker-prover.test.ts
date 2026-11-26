import { expect, it } from "vitest"
import type { IGroth16Prover } from "../../src/sdk.ts"
import { type ProverPort, serveProver, workerProver } from "../../src/runtime/worker-prover.ts"

const PROOF = { proof: { pi_a: ["1"], pi_b: [["2"]], pi_c: ["3"], protocol: "groth16", curve: "bn128" }, publicSignals: ["7"] }

it("answers each call from the worker side and turns a thrown error into a rejection", async () => {
	const { port1, port2 } = new MessageChannel()
	const seen: number[] = []
	const fake = {
		fullProve: async (_input, wasm, zkey) => {
			seen.push(wasm.byteLength, zkey.byteLength)
			return PROOF
		},
		verify: async () => {
			throw new Error("bad vkey")
		},
	} as IGroth16Prover
	serveProver(port2 as unknown as ProverPort, fake)
	const prover = workerProver(port1 as unknown as ProverPort)
	port1.start()
	port2.start()
	try {
		const wasm = new Uint8Array(3)
		const [a, b] = await Promise.all([prover.fullProve({}, wasm, new Uint8Array(5)), prover.fullProve({}, wasm, new Uint8Array(5))])
		expect([a, b]).toEqual([PROOF, PROOF])
		expect(seen).toEqual([3, 5, 3, 5])
		expect(wasm.byteLength).toBe(3)
		await expect(prover.verify({} as never, [], PROOF.proof as never)).rejects.toThrow("prover worker: bad vkey")
	} finally {
		port1.close()
	}
})

it("rejects pending and later calls once the worker fails or is terminated", async () => {
	const port = Object.assign(new EventTarget(), { postMessage() {}, terminated: false })
	const prover = workerProver(port as ProverPort)
	const pending = prover.fullProve({}, new Uint8Array(), new Uint8Array())
	port.dispatchEvent(new Event("error", { cancelable: true }))
	await expect(pending).rejects.toThrow("prover worker failed")
	await expect(prover.verify({} as never, [], {} as never)).rejects.toThrow("prover worker failed")

	const other = Object.assign(new EventTarget(), {
		postMessage() {},
		terminate() {
			this.terminated = true
		},
		terminated: false,
	})
	const stopped = workerProver(other as ProverPort)
	const inFlight = stopped.fullProve({}, new Uint8Array(), new Uint8Array())
	stopped.terminate()
	expect(other.terminated).toBe(true)
	await expect(inFlight).rejects.toThrow("prover worker terminated")
})
