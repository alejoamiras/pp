import type { IGroth16Prover } from "../sdk.ts"

type Op = keyof IGroth16Prover
type Call = { [K in Op]: { id: number; op: K; args: Parameters<IGroth16Prover[K]> } }[Op]
type Reply = { id: number; ok: true; value: unknown } | { id: number; ok: false; message: string }

/** The part of a `Worker` (or a `MessagePort`) the prover uses. */
export type ProverPort = {
	postMessage(message: unknown): void
	addEventListener(type: "message" | "messageerror" | "error", listener: (e: Event) => void): void
	terminate?(): void
}

export interface WorkerProver extends IGroth16Prover {
	/** Stops the worker; pending and later calls reject. */
	terminate(): void
}

/**
 * An `IGroth16Prover` that proves in a worker serving `serveProver`, so the calling thread stays responsive.
 * Circuit files are copied to the worker on each call, never transferred: the artifact loader keeps them.
 * Once the worker reports an error, every pending and later call rejects with it.
 */
export function workerProver(worker: ProverPort): WorkerProver {
	let next = 0
	let dead: Error | undefined
	const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
	const fail = (err: Error) => {
		dead ??= err
		for (const p of pending.values()) p.reject(dead)
		pending.clear()
	}
	worker.addEventListener("message", (e) => {
		const r = (e as MessageEvent<Reply>).data
		const p = pending.get(r.id)
		if (p === undefined) return
		pending.delete(r.id)
		if (r.ok) p.resolve(r.value)
		else p.reject(new Error(`prover worker: ${r.message}`))
	})
	worker.addEventListener("messageerror", () => fail(new Error("prover worker sent a message that could not be read")))
	worker.addEventListener("error", (e) => {
		e.preventDefault()
		fail(new Error(`prover worker failed: ${(e as ErrorEvent).message ?? "unknown error"}`))
	})
	const call = (op: Op, args: Call["args"]) =>
		new Promise<unknown>((resolve, reject) => {
			if (dead) return reject(dead)
			const id = next++
			pending.set(id, { resolve, reject })
			worker.postMessage({ id, op, args })
		})
	return {
		fullProve: (...args) => call("fullProve", args) as ReturnType<IGroth16Prover["fullProve"]>,
		verify: (...args) => call("verify", args) as ReturnType<IGroth16Prover["verify"]>,
		terminate() {
			worker.terminate?.()
			fail(new Error("prover worker terminated"))
		},
	}
}

/** The worker side of `workerProver`: answers each call with `prover`. Errors cross as their message only. */
export function serveProver(scope: ProverPort, prover: IGroth16Prover): void {
	scope.addEventListener("message", async (e) => {
		const c = (e as MessageEvent<Call>).data
		try {
			const value = c.op === "fullProve" ? await prover.fullProve(...c.args) : await prover.verify(...c.args)
			scope.postMessage({ id: c.id, ok: true, value } satisfies Reply)
		} catch (err) {
			scope.postMessage({ id: c.id, ok: false, message: err instanceof Error ? err.message : String(err) } satisfies Reply)
		}
	})
}
