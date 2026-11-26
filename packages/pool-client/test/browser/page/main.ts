// The package entry comes first, so its Buffer shim runs before the SDK's bundle evaluates.
import { createArtifacts, createProver, PoolClientError } from "../../../src/index.ts"
import { ProofService } from "@0xbow/privacy-pools-v2-sdk"
import { offlineTransactWitness } from "../../support/offline-witness.ts"

export type ProveResult = { loadMs: number; proveMs: number; verified: boolean; signals: string[] }
export type EnsureResult = { ok: true } | { ok: false; code?: string; circuit?: string; file?: string; message: string }

async function prove(gatewayPath: string): Promise<ProveResult> {
	const artifacts = createArtifacts({ kind: "gateway", urls: [`${location.origin}${gatewayPath}`] })
	const proofs = new ProofService({ circuitArtifacts: artifacts, groth16Prover: createProver() })
	const spend = await offlineTransactWitness()
	const t0 = performance.now()
	await artifacts.ensure("transact_1x1")
	const t1 = performance.now()
	const result = await proofs.proveTransact(spend.witness as never, 1, 1)
	const t2 = performance.now()
	return {
		loadMs: t1 - t0,
		proveMs: t2 - t1,
		verified: await proofs.verifyTransact(result, 1, 1),
		signals: result.publicSignals.map((s) => BigInt(s).toString()),
	}
}

async function ensure(gatewayPath: string): Promise<EnsureResult> {
	try {
		await createArtifacts({ kind: "gateway", urls: [`${location.origin}${gatewayPath}`] }).ensure("transact_1x1")
		return { ok: true }
	} catch (e) {
		if (e instanceof PoolClientError) return { ok: false, code: e.code, circuit: e.circuit, file: e.file, message: e.message }
		return { ok: false, message: String(e) }
	}
}

;(globalThis as { probe?: unknown }).probe = { prove, ensure }
