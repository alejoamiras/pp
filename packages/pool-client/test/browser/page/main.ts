// The package entry comes first, so its Buffer shim runs before the SDK's bundle evaluates.
import {
	createArtifacts,
	createProver,
	type IGroth16Prover,
	openPoolClient,
	PoolClientError,
	type PoolConfig,
	workerProver,
} from "../../../src/index.ts"
import { ProofService } from "@0xbow/privacy-pools-v2-sdk"
import type { Address, Hex } from "viem"
import { offlineTransactWitness } from "../../support/offline-witness.ts"
import { decode, encode } from "../../support/wire.ts"

export type SpendInput = { pool: PoolConfig; address: Address; signature: Hex; note: bigint; amount: bigint; processor: Address; data: Hex }

export type ProveResult = { loadMs: number; proveMs: number; maxStallMs: number; verified: boolean; signals: string[] }
export type ProveOn = "main" | "worker"
export type EnsureResult = { ok: true } | { ok: false; code?: string; circuit?: string; file?: string; message: string }

/** The longest gap between 10 ms ticks on this thread while `work` runs. */
async function heartbeat<T>(work: () => Promise<T>): Promise<{ value: T; maxStallMs: number }> {
	let last = performance.now()
	let maxStallMs = 0
	const tick = () => {
		const now = performance.now()
		maxStallMs = Math.max(maxStallMs, now - last)
		last = now
	}
	const timer = setInterval(tick, 10)
	try {
		const value = await work()
		tick()
		return { value, maxStallMs }
	} finally {
		clearInterval(timer)
	}
}

const newProver = (on: ProveOn): IGroth16Prover & { terminate?(): void } =>
	on === "worker" ? workerProver(new Worker(new URL("./prover-worker.ts", import.meta.url), { type: "module" })) : createProver()

async function prove(gatewayPath: string, on: ProveOn = "main"): Promise<ProveResult> {
	const artifacts = createArtifacts({ kind: "gateway", urls: [`${location.origin}${gatewayPath}`] })
	const prover = newProver(on)
	const proofs = new ProofService({ circuitArtifacts: artifacts, groth16Prover: prover })
	const spend = await offlineTransactWitness()
	try {
		const t0 = performance.now()
		await artifacts.ensure("transact_1x1")
		const t1 = performance.now()
		const { value: result, maxStallMs } = await heartbeat(() => proofs.proveTransact(spend.witness as never, 1, 1))
		const t2 = performance.now()
		return {
			loadMs: t1 - t0,
			proveMs: t2 - t1,
			maxStallMs,
			verified: await proofs.verifyTransact(result, 1, 1),
			signals: result.publicSignals.map((s) => BigInt(s).toString()),
		}
	} finally {
		prover.terminate?.()
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

/** Opens a client in the page, lists notes and prepares a spend, proving in a worker; bigints cross as `wire.ts` JSON. */
async function spend(input: string): Promise<string> {
	const a = decode<SpendInput>(input)
	const prover = newProver("worker")
	try {
		const client = await openPoolClient({
			pool: a.pool,
			l1Address: a.address,
			signature: a.signature,
			artifacts: { kind: "gateway", urls: [`${location.origin}/ipfs`] },
			prover,
		})
		const notes = await client.notes()
		const t0 = performance.now()
		const prepared = await client.prepareSpend({ note: a.note, amount: a.amount, processor: a.processor, data: a.data })
		return encode({ notes, spend: prepared, prepareMs: performance.now() - t0 })
	} finally {
		prover.terminate?.()
	}
}

;(globalThis as { probe?: unknown }).probe = { prove, ensure, spend }
