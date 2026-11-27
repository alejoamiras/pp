import type { IGroth16Prover, WorkerProver } from "@pp/pool-client"
import { PROVE_DEADLINE_MS } from "../bridge-driver"
import { BridgeFailure } from "../errors"
import type { Timer } from "../ports"

export interface DelegatingProver extends IGroth16Prover {
	/** Ends the current worker, so its pending calls reject; the next call gets a fresh one. */
	cancel(): void
}

/**
 * The one prover a page keeps, handed to the pool client once. Every call goes to the current worker
 * under the deadline: snarkjs can hang with no error, and the bridge client re-proves inside a submit,
 * so each internal re-proof needs the same bound as the first proof. On expiry the worker is
 * terminated, the call rejects with `PROVE_TIMEOUT` and the next call starts a fresh worker, so at most
 * one is alive and the client is never reopened (that would re-derive keys and re-sync notes).
 */
export function delegatingProver(spawn: () => WorkerProver, timer: Timer, deadlineMs: number = PROVE_DEADLINE_MS): DelegatingProver {
	let current: WorkerProver | null = null
	const cancel = () => {
		current?.terminate()
		current = null
	}
	async function bounded<T>(call: (p: WorkerProver) => Promise<T>): Promise<T> {
		current ??= spawn()
		const worker = current
		const stop = new AbortController()
		let expiredFirst = false
		const expired = timer.sleep(deadlineMs, stop.signal).then((elapsed): Promise<never> => {
			if (!elapsed) return new Promise<never>(() => {})
			expiredFirst = true
			if (current === worker) cancel()
			throw new BridgeFailure("PROVE_TIMEOUT")
		})
		try {
			return await Promise.race([call(worker), expired])
		} catch (err) {
			// Terminating rejects the pending call before the deadline's own rejection lands.
			throw expiredFirst ? new BridgeFailure("PROVE_TIMEOUT") : err
		} finally {
			stop.abort()
		}
	}
	return {
		fullProve: (...args) => bounded((p) => p.fullProve(...args)),
		verify: (...args) => bounded((p) => p.verify(...args)),
		cancel,
	}
}
