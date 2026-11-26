import { expect, it } from "vitest"
import type { IGroth16Prover } from "../../src/sdk.ts"
import { type ProverPort, serveProver, workerProver } from "../../src/runtime/worker-prover.ts"

const PROOF = { proof: { pi_a: ["1"], pi_b: [["2"]], pi_c: ["3"], protocol: "groth16", curve: "bn128" }, publicSignals: ["7"] }

it("routes each reply to its own call, out of order, and rejects a thrown error", async () => {
	const { port1, port2 } = new MessageChannel()
	// Each proof echoes its zkey's length; the shorter zkey answers later, so replies arrive out of order.
	const fake = {
		fullProve: async (_input, _wasm, zkey) => {
			await new Promise((r) => setTimeout(r, 40 - zkey.byteLength))
			return { ...PROOF, publicSignals: [String(zkey.byteLength)] }
		},
		verify: async () => {
			throw new Error("bad vkey")
		},
	} as IGroth16Prover
	serveProver(port2 as unknown as ProverPort, fake)
	const a = workerProver(port1 as unknown as ProverPort)
	const b = workerProver(port1 as unknown as ProverPort)
	expect(b).toBe(a)
	port1.start()
	port2.start()
	try {
		const wasm = new Uint8Array(3)
		const signals = await Promise.all(
			[a.fullProve({}, wasm, new Uint8Array(5)), b.fullProve({}, wasm, new Uint8Array(30))].map(async (p) => (await p).publicSignals),
		)
		expect(signals).toEqual([["5"], ["30"]])
		expect(wasm.byteLength).toBe(3)
		await expect(a.verify({} as never, [], PROOF.proof as never)).rejects.toThrow("prover worker: bad vkey")
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
