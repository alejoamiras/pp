import { type IGroth16Prover, type ProverPort, type WorkerProver, workerProver } from "@pp/pool-client"
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
 *
 * @param spawn starts a worker and calls `died` once it can answer no call (later, never during
 *   `spawn`), so the next call starts a fresh one instead of failing on the dead one until a reload.
 */
export function delegatingProver(
	spawn: (died: () => void) => WorkerProver,
	timer: Timer,
	deadlineMs: number = PROVE_DEADLINE_MS,
): DelegatingProver {
	let current: WorkerProver | null = null
	const cancel = () => {
		current?.terminate()
		current = null
	}
	const start = (): WorkerProver => {
		const worker: WorkerProver = spawn(() => {
			if (current === worker) cancel()
		})
		return worker
	}
	async function bounded<T>(call: (p: WorkerProver) => Promise<T>): Promise<T> {
		current ??= start()
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

/** A `spawn` for {@link delegatingProver} over the worker port `open` starts. */
export const spawnWorker =
	(open: () => ProverPort): ((died: () => void) => WorkerProver) =>
	(died) => {
		const port = open()
		// Exactly workerProver's two ways to die, heard before its own listeners: microtasks run between
		// listeners, so the worker is dropped before anything chained on its rejected calls can reach it.
		port.addEventListener("error", died)
		port.addEventListener("messageerror", died)
		return workerProver(port)
	}
