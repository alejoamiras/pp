import type { ProverPort, WorkerProver } from "@pp/pool-client"
import { describe, expect, test } from "vitest"
import { virtualTimer } from "../../test-utils/timer"
import { delegatingProver, spawnWorker } from "./prover"

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

/** Worker ports the browser drives: each event reaches its listeners one at a time, with microtasks run between them. */
function fakePorts() {
	const all: { posted: unknown[]; terminations: number; fire(type: string, event?: Event): Promise<void> }[] = []
	const open = (): ProverPort => {
		const listeners = new Map<string, ((e: Event) => void)[]>()
		const p = {
			posted: [] as unknown[],
			terminations: 0,
			async fire(type: string, event: Event = new Event(type, { cancelable: true })) {
				for (const listener of listeners.get(type) ?? []) {
					listener(event)
					await new Promise((r) => setTimeout(r, 0))
				}
			},
		}
		all.push(p)
		return {
			postMessage: (m) => void p.posted.push(m),
			addEventListener: (type, listener) => void listeners.set(type, [...(listeners.get(type) ?? []), listener]),
			terminate: () => void p.terminations++,
		}
	}
	return { all, open }
}

const answer = (value: unknown) => new MessageEvent("message", { data: { id: 0, ok: true, value } })

describe("a worker that dies", () => {
	test.each(["error", "messageerror"])(
		"on %s is dropped before its pending proof rejects, so a retry chained on the rejection starts a fresh worker",
		async (event) => {
			const { all, open } = fakePorts()
			const prover = delegatingProver(spawnWorker(open), virtualTimer(), DEADLINE)
			let retry: Promise<unknown> | undefined
			const first = prover.fullProve(...PROVE_ARGS).catch((err: unknown) => {
				retry = prover.fullProve(...PROVE_ARGS)
				return err
			})
			await all[0]?.fire(event)
			expect(await first).toMatchObject({ message: "prover worker terminated" })
			expect(all.map((p) => [p.terminations, p.posted.length])).toEqual([
				[1, 1],
				[0, 1],
			])
			await all[1]?.fire("message", answer("proof"))
			await expect(retry).resolves.toBe("proof")
		},
	)

	test("after a timeout replaced it leaves the replacement alone", async () => {
		const timer = virtualTimer()
		const { all, open } = fakePorts()
		const prover = delegatingProver(spawnWorker(open), timer, DEADLINE)
		const first = prover.fullProve(...PROVE_ARGS)
		timer.advance(DEADLINE)
		await expect(first).rejects.toMatchObject({ code: "PROVE_TIMEOUT" })
		const second = prover.fullProve(...PROVE_ARGS)
		await all[0]?.fire("error")
		expect(all.map((p) => p.terminations)).toEqual([1, 0])
		await all[1]?.fire("message", answer("proof"))
		await expect(second).resolves.toBe("proof")
		expect(all).toHaveLength(2)
	})
})
