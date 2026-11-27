import { describe, expect, test } from "bun:test"
import { type Address, getAddress, type Hex, keccak256, numberToHex, pad, toFunctionSelector } from "viem"
import { type Bindings, PINS, type Pins } from "./pins.ts"
import { checkEndpoint, checkFork, checkLive, drifted, PreflightError, readBindings } from "./preflight.ts"
import type { Rpc } from "./rpc.ts"

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
/** Read on the real fork at block 12220000: the vault's 1x1 route under its ERC-7201 router location. */
const ROUTE_SLOT_1X1 = "0xb7b79b806246c77112a27b9e7ae6b83277c6c9720f5c5c98393144d574aa07dd"

const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`)
const word = (a: Address): Hex => pad(a, { size: 32 })
const codeOf = (a: Address): Hex => `0x73${a.slice(2).toLowerCase()}`

/** A chain whose answers derive from `b`, and the pins that match it exactly. */
function chain(b: Omit<Bindings, `${string}CodeHash`>, o: { chainId?: number; blockHash?: Hex; pruned?: boolean } = {}) {
	const pins: Pins = {
		...PINS,
		bindings: {
			...b,
			vaultImplementationCodeHash: keccak256(codeOf(b.vaultImplementation)),
			transact1x1VerifierCodeHash: keccak256(codeOf(b.transact1x1Verifier)),
			inboxCodeHash: keccak256(codeOf(b.inbox)),
		},
	}
	const calls: Record<string, Hex> = {
		[`${PINS.pool.vault}:depositVerifier()`]: word(b.depositVerifier),
		[`${PINS.aztec.registry}:getCanonicalRollup()`]: word(b.rollup),
		[`${b.rollup}:getInbox()`]: word(b.inbox),
		[`${b.rollup}:getOutbox()`]: word(b.outbox),
		[`${b.rollup}:getVersion()`]: numberToHex(b.rollupVersion, { size: 32 }),
	}
	const bySelector = new Map(
		Object.entries(calls).map(([k, v]) => [`${k.split(":")[0]!.toLowerCase()}:${toFunctionSelector(k.split(":")[1]!)}`, v]),
	)
	const route = `0x0000000000000000${b.transact1x1Selector.slice(2)}${b.transact1x1Verifier.slice(2).toLowerCase()}` as Hex
	const storage = (slot: unknown): Hex => {
		if (o.pruned) throw new Error("missing trie node")
		return slot === IMPL_SLOT ? word(b.vaultImplementation) : slot === ROUTE_SLOT_1X1 ? route : pad("0x0")
	}
	const call = ({ to, data }: { to: string; data: string }): Hex => {
		const hit = bySelector.get(`${to.toLowerCase()}:${data}`)
		if (hit === undefined) throw new Error(`unexpected call ${to} ${data}`)
		return hit
	}
	const handlers: Record<string, (params: unknown[]) => unknown> = {
		eth_chainId: () => numberToHex(o.chainId ?? 11_155_111),
		eth_getBlockByNumber: () => ({ hash: o.blockHash ?? PINS.block.hash, number: "0xba9000" }),
		eth_getStorageAt: ([, slot]) => storage(slot),
		eth_getCode: ([a]) => codeOf(getAddress(a as string)),
		eth_call: ([c]) => call(c as { to: string; data: string }),
	}
	const rpc: Rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
		const handler = handlers[method]
		if (!handler) throw new Error(`unexpected ${method}`)
		return handler(params) as T
	}
	return { rpc, pins }
}

const BASE = {
	vaultImplementation: addr(1),
	depositVerifier: addr(2),
	transact1x1Verifier: addr(3),
	transact1x1Selector: "0xc9219a7a",
	rollup: addr(4),
	rollupVersion: 679_261_766n,
	inbox: addr(5),
	outbox: addr(6),
} as const

const rejection = async (p: Promise<unknown>) => {
	const err = await p.then(
		() => undefined,
		(e: unknown) => e,
	)
	expect(err).toBeInstanceOf(PreflightError)
	return err as PreflightError
}

describe("the preflight", () => {
	test("reads every binding, the 1x1 route from the slot the real vault uses", async () => {
		const { rpc, pins } = chain(BASE)
		expect(await readBindings(rpc, pins, pins.block.number)).toEqual(pins.bindings)
		await checkFork(rpc, pins)
		expect(await checkLive(rpc, pins)).toBe(0xba9000n)
	})

	test("names the pin that drifted on the fork, and the live bindings that moved", async () => {
		const { pins } = chain(BASE)
		const movedInbox = chain({ ...BASE, inbox: addr(9) }).rpc
		const onFork = await rejection(checkFork(movedInbox, pins))
		expect(onFork.kind).toBe("pin")
		expect(onFork.pins).toEqual(["inbox", "inboxCodeHash"])
		expect(onFork.message).toContain(`inbox is ${addr(9)}, pinned ${addr(5)}`)
		const rotated = chain({ ...BASE, rollup: addr(7), transact1x1Verifier: addr(8) }).rpc
		const live = await rejection(checkLive(rotated, pins))
		expect(live.kind).toBe("live")
		expect([...live.pins].sort()).toEqual(["rollup", "transact1x1Verifier", "transact1x1VerifierCodeHash"])
	})

	test("tells an endpoint that no longer serves the block from one whose block differs from the pin", async () => {
		const { pins } = chain(BASE)
		const pruned = await rejection(checkEndpoint(chain(BASE, { pruned: true }).rpc, pins, "rpc.example"))
		expect([pruned.kind, pruned.message]).toEqual(["endpoint", "rpc.example no longer serves block 12220000: missing trie node"])
		const otherHash = await rejection(checkEndpoint(chain(BASE, { blockHash: `0x${"ab".repeat(32)}` }).rpc, pins, "rpc.example"))
		expect([otherHash.kind, otherHash.pins]).toEqual(["pin", ["block.hash"]])
		const mainnet = await rejection(checkEndpoint(chain(BASE, { chainId: 1 }).rpc, pins, "rpc.example"))
		expect([mainnet.kind, mainnet.pins]).toEqual(["pin", ["chainId"]])
		const forkHash = await rejection(checkFork(chain(BASE, { blockHash: `0x${"cd".repeat(32)}` }).rpc, pins))
		expect([forkHash.kind, forkHash.pins]).toEqual(["pin", ["block.hash"]])
	})

	test("compares addresses and hashes without regard to case", () => {
		const { pins } = chain(BASE)
		const lower = { ...pins.bindings, inbox: pins.bindings.inbox.toLowerCase() as Address }
		expect(drifted(lower, pins.bindings)).toEqual([])
	})
})
