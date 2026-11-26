import { dirname } from "node:path"
import { Groth16Prover, type IGroth16Prover, LocalCircuitArtifacts, ProofService } from "#ppv2/evm-sdk"

type Snarkjs = { curves: { getCurveFromName(name: string, opts: { singleThread: boolean }): Promise<unknown> } }
type CurveSlot = { curve_bn128?: unknown }

let snarkjs: Promise<Snarkjs> | undefined
let curve: Promise<unknown> | undefined

// Resolve snarkjs from the SDK's own directory so the curve comes from the copy the SDK proves with.
function loadSnarkjs(): Promise<Snarkjs> {
	snarkjs ??= import(Bun.resolveSync("snarkjs", dirname(Bun.resolveSync("#ppv2/evm-sdk", import.meta.dir))))
	return snarkjs
}

/**
 * Under Bun, ffjavascript's worker-thread curve never settles, so fullProve and verify hang.
 * snarkjs reuses `globalThis.curve_bn128` when it is set, but every ffjavascript copy nulls that
 * slot when it loads, so the single-thread curve is put back before each call.
 */
async function useSingleThreadCurve(): Promise<void> {
	curve ??= loadSnarkjs().then((s) => s.curves.getCurveFromName("bn128", { singleThread: true }))
	;(globalThis as CurveSlot).curve_bn128 = await curve
}

export function singleThreadProver(inner: IGroth16Prover = new Groth16Prover()): IGroth16Prover {
	return {
		async fullProve(input, wasm, provingKey) {
			await useSingleThreadCurve()
			return inner.fullProve(input, wasm, provingKey)
		},
		async verify(verificationKey, publicSignals, proof) {
			await useSingleThreadCurve()
			return inner.verify(verificationKey, publicSignals, proof)
		},
	}
}

export function createProofService(circuitsDir: string): ProofService {
	return new ProofService({
		circuitArtifacts: new LocalCircuitArtifacts({ baseDir: circuitsDir }),
		groth16Prover: singleThreadProver(),
	})
}
