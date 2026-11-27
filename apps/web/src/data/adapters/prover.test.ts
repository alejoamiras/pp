import type { WorkerProver } from "@pp/pool-client"
import { describe, expect, test } from "vitest"
import { virtualTimer } from "../../test-utils/timer"
import { delegatingProver } from "./prover"

const DEADLINE = 1_000
const PROVE_ARGS = [{}, new Uint8Array(), new Uint8Array()] as unknown as Parameters<WorkerProver["fullProve"]>
const VERIFY_ARGS = [{}, [], {}] as unknown as Parameters<WorkerProver["verify"]>

/** Workers whose calls stay pending until the test settles them; terminating rejects what is pending. */
function fakeWorkers() {
	const workers: { pending: ((v: unknown) => void)[]; terminated: boolean }[] = []
	const spawn = (): WorkerProver => {
		const w = { pending: [] as ((v: unknown) => void)[], rejects: [] as ((e: Error) => void)[], terminated: false }
		workers.push(w)
		const call = () =>
			new Promise<unknown>((resolve, reject) => {
				w.pending.push(resolve)
				w.rejects.push(reject)
			}) as Promise<never>
		return {
			fullProve: call,
			verify: call,
			terminate() {
				w.terminated = true
				for (const r of w.rejects) r(new Error("prover worker terminated"))
			},
		}
	}
	return { workers, spawn }
}

describe("the page's delegating prover", () => {
	test("every call, a re-proof included, runs under the deadline; expiry ends the worker and the next call starts one fresh", async () => {
		const timer = virtualTimer()
		const { workers, spawn } = fakeWorkers()
		const prover = delegatingProver(spawn, timer, DEADLINE)
		expect(workers).toHaveLength(0)

		const first = prover.fullProve(...PROVE_ARGS)
		workers[0]?.pending[0]?.("proof")
		await expect(first).resolves.toBe("proof")
		timer.advance(DEADLINE * 5)
		expect(workers[0]?.terminated).toBe(false)

		const reproof = prover.fullProve(...PROVE_ARGS)
		timer.advance(DEADLINE)
		await expect(reproof).rejects.toMatchObject({ code: "PROVE_TIMEOUT" })
		expect(workers[0]?.terminated).toBe(true)

		const verified = prover.verify(...VERIFY_ARGS)
		expect(workers).toHaveLength(2)
		workers[1]?.pending[0]?.(true)
		await expect(verified).resolves.toBe(true)
	})

	test("cancel ends the worker, its pending proof fails as the worker's error, and the next proof gets a new worker", async () => {
		const { workers, spawn } = fakeWorkers()
		const prover = delegatingProver(spawn, virtualTimer(), DEADLINE)
		const pending = prover.fullProve(...PROVE_ARGS)
		prover.cancel()
		await expect(pending).rejects.toThrow("prover worker terminated")
		void prover.fullProve(...PROVE_ARGS)
		expect(workers.map((w) => w.terminated)).toEqual([true, false])
	})
})
