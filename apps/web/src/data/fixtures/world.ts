/**
 * The in-memory world every fixture port reads and writes. Time is chain time: Ethereum moves 12 s per
 * block, Aztec lands a block every six, and nothing moves until `advance` mines. The virtual timer the
 * driver's waits use runs on the same blocks. The state is copied to `sessionStorage` after every
 * change, so a reload mid-bridge resumes; it holds no signature, key, salt or proof.
 */
import type { StaleRootCode } from "../stack-types"
import type { ChainClock, Deployment, Timer } from "../ports"
import { decode, encode } from "./codec"
import type { FixtureOp } from "./faults"
import { fixtureDeployment, GENESIS, L1_BLOCK_SECONDS, L1_BLOCKS_PER_AZTEC_BLOCK, seedWorld, type WorldState } from "./seed"

export type KeyValue = Pick<Storage, "getItem" | "setItem" | "removeItem">

export const STORAGE_KEY = "pp.fixtures.world.v1"
const MS_PER_BLOCK = Number(L1_BLOCK_SECONDS) * 1000

function load(storage: KeyValue | null, chainId: number): WorldState {
	try {
		const text = storage?.getItem(STORAGE_KEY)
		const parsed = text ? (decode(text) as WorldState) : null
		if (parsed?.v === 1 && parsed.chainId === chainId) return parsed
	} catch {
		// A corrupt copy starts a fresh world.
	}
	return seedWorld(chainId)
}

type Subscribe = (f: () => void) => () => void

/** Milliseconds of block time: `sleep` settles on the update that mines past its due time. */
function virtualTimer(now: () => number, subscribe: Subscribe): Timer {
	return {
		now,
		sleep(ms, signal) {
			const due = now() + ms
			if (signal?.aborted) return Promise.resolve(false)
			if (now() >= due) return Promise.resolve(true)
			return new Promise<boolean>((resolve) => {
				const done = (elapsed: boolean) => {
					off()
					signal?.removeEventListener("abort", onAbort)
					resolve(elapsed)
				}
				const onAbort = () => done(false)
				const off = subscribe(() => {
					if (now() >= due) done(true)
				})
				signal?.addEventListener("abort", onAbort, { once: true })
			})
		},
	}
}

export interface World {
	readonly deployment: Deployment
	/** The live state; mutate it only inside `update`. */
	readonly s: WorldState
	update<T>(f: (s: WorldState) => T): T
	/** Resolves once `pred` holds after some update; stays pending if `signal` aborts first. */
	until(pred: () => boolean, signal?: AbortSignal): Promise<void>
	subscribe: Subscribe
	/** The armed fault for `op`, consumed. */
	takeFault(op: FixtureOp): string | null
	takeHang(op: FixtureOp): boolean
	takeReprove(): StaleRootCode | null
	aztecBlock(): number
	l1Time(): bigint
	aztecTime(): bigint
	/** A fresh, distinct hex value of `bytes` bytes (hashes, ids). */
	nextHex(bytes: number): `0x${string}`
	readonly clock: ChainClock
	readonly timer: Timer
	reset(): void
}

export function createWorld(o: { chainId: number; storage: KeyValue | null }): World {
	let s = load(o.storage, o.chainId)
	const listeners = new Set<() => void>()
	const save = () => {
		try {
			o.storage?.setItem(STORAGE_KEY, encode(s))
		} catch {
			// A full or blocked store keeps the world in memory only.
		}
	}
	const subscribe: Subscribe = (f) => {
		listeners.add(f)
		return () => void listeners.delete(f)
	}
	function update<T>(f: (s: WorldState) => T): T {
		const out = f(s)
		save()
		for (const l of [...listeners]) l()
		return out
	}
	function take<T>(list: T[], match: (x: T) => boolean): T | null {
		const i = list.findIndex(match)
		if (i < 0) return null
		const [x] = list.splice(i, 1)
		save()
		return x ?? null
	}
	const aztecBlock = () => Math.floor(s.l1Block / L1_BLOCKS_PER_AZTEC_BLOCK)
	const l1Time = () => GENESIS + BigInt(s.l1Block) * L1_BLOCK_SECONDS
	const aztecTime = () => GENESIS + BigInt(aztecBlock() * L1_BLOCKS_PER_AZTEC_BLOCK) * L1_BLOCK_SECONDS
	return {
		deployment: fixtureDeployment(o.chainId),
		get s() {
			return s
		},
		update,
		until: (pred, signal) =>
			new Promise<void>((resolve) => {
				if (pred()) return resolve()
				const off = subscribe(() => {
					if (!pred()) return
					off()
					resolve()
				})
				signal?.addEventListener("abort", off, { once: true })
			}),
		subscribe,
		takeFault: (op) => take(s.faults.fail, (f) => f.op === op)?.code ?? null,
		takeHang: (op) => take(s.faults.hang, (h) => h === op) !== null,
		takeReprove: () => take(s.faults.reprove, () => true) as StaleRootCode | null,
		aztecBlock,
		l1Time,
		aztecTime,
		nextHex: (bytes) =>
			`0x${update((st) => ++st.counter)
				.toString(16)
				.padStart(bytes * 2, "0")}`,
		clock: { aztecNow: async () => aztecTime(), l1Now: async () => l1Time() },
		timer: virtualTimer(() => s.l1Block * MS_PER_BLOCK, subscribe),
		reset() {
			s = seedWorld(o.chainId)
			update(() => undefined)
		},
	}
}
