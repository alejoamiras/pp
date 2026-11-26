// snarkjs ships no types; the reference carries its declaration to consumers that compile this file through imports.
/// <reference path="../snarkjs.d.ts" />
import { curves } from "snarkjs"
import { Groth16Prover, type IGroth16Prover } from "../sdk.ts"

let curve: Promise<unknown> | undefined

/**
 * Under Bun, ffjavascript's worker-thread curve never settles, so fullProve and verify hang.
 * snarkjs reuses `globalThis.curve_bn128` when it is set, but every ffjavascript copy nulls that
 * slot when it loads, so the single-thread curve is put back before each call.
 */
async function useSingleThreadCurve(): Promise<void> {
	curve ??= curves.getCurveFromName("bn128", { singleThread: true })
	;(globalThis as { curve_bn128?: unknown }).curve_bn128 = await curve
}

function singleThread(inner: IGroth16Prover): IGroth16Prover {
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

export function createProver(): IGroth16Prover {
	const inner = new Groth16Prover()
	return "Bun" in globalThis ? singleThread(inner) : inner
}
