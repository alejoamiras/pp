import { describe, expect, test } from "bun:test"
import { type Address, getAddress, type Hex, keccak256, numberToHex, pad, toFunctionSelector } from "viem"
import { EIP1967_IMPLEMENTATION_SLOT, POOL_CONTRACTS, type PoolContract } from "./code.ts"
import { type Bindings, type Pins, TARGETS } from "./pins.ts"
import { checkEndpoint, checkFork, checkLive, drifted, enroll, PreflightError, readBindings } from "./preflight.ts"
import type { Rpc } from "./rpc.ts"

/** Read on the real fork at block 12220000: the vault's 1x1 route under its ERC-7201 router location. */
const ROUTE_SLOT_1X1 = "0xb7b79b806246c77112a27b9e7ae6b83277c6c9720f5c5c98393144d574aa07dd"
const TARGET = TARGETS.pool1

const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`)
const word = (a: Address): Hex => pad(a, { size: 32 })
const codeOf = (a: Address): Hex => `0x73${a.slice(2).toLowerCase()}`

type Chain = Omit<Bindings, "code" | `${string}CodeHash`> & { implementations: Record<PoolContract, Address> }
type Options = {
	chainId?: number
	blockHash?: Hex
	pruned?: boolean
	wiring?: Partial<Record<"keystore" | "aspRegistry" | "poolVault", Address>>
}

/** A chain whose answers derive from `b`, and the pins that match it exactly. */
function chain(b: Chain, o: Options = {}) {
	const { implementations, ...flat } = b
	const { pool } = TARGET
	const code = Object.fromEntries(
		POOL_CONTRACTS.map((c) => [
			c,
			{
				proxy: getAddress(pool[c]),
				proxyCodeHash: keccak256(codeOf(getAddress(pool[c]))),
				implementation: implementations[c],
				implementationCodeHash: keccak256(codeOf(implementations[c])),
			},
		]),
	) as Bindings["code"]
	const pins: Pins = {
		...TARGET,
		bindings: {
			...flat,
			code,
			transact1x1VerifierCodeHash: keccak256(codeOf(b.transact1x1Verifier)),
			inboxCodeHash: keccak256(codeOf(b.inbox)),
		},
	}
	const calls: Record<string, Hex> = {
		[`${pool.vault}:depositVerifier()`]: word(b.depositVerifier),
		[`${pool.vault}:keystore()`]: word(o.wiring?.keystore ?? pool.keystore),
		[`${pool.vault}:aspRegistry()`]: word(o.wiring?.aspRegistry ?? pool.aspRegistry),
		[`${pool.entrypoint}:poolVault()`]: word(o.wiring?.poolVault ?? pool.vault),
		[`${TARGET.aztec.registry}:getCanonicalRollup()`]: word(b.rollup),
		[`${b.rollup}:getInbox()`]: word(b.inbox),
		[`${b.rollup}:getOutbox()`]: word(b.outbox),
		[`${b.rollup}:getVersion()`]: numberToHex(b.rollupVersion, { size: 32 }),
	}
	const bySelector = new Map(
		Object.entries(calls).map(([k, v]) => [`${k.split(":")[0]!.toLowerCase()}:${toFunctionSelector(k.split(":")[1]!)}`, v]),
	)
	const route = `0x0000000000000000${b.transact1x1Selector.slice(2)}${b.transact1x1Verifier.slice(2).toLowerCase()}` as Hex
	const proxyOf = new Map(POOL_CONTRACTS.map((c) => [pool[c].toLowerCase(), implementations[c]]))
	const storage = (at: string, slot: unknown): Hex => {
		if (o.pruned) throw new Error("missing trie node")
		if (slot === EIP1967_IMPLEMENTATION_SLOT) return word(proxyOf.get(at.toLowerCase()) ?? addr(0))
		return slot === ROUTE_SLOT_1X1 ? route : pad("0x0")
	}
	const call = ({ to, data }: { to: string; data: string }): Hex => {
		const hit = bySelector.get(`${to.toLowerCase()}:${data}`)
		if (hit === undefined) throw new Error(`unexpected call ${to} ${data}`)
		return hit
	}
	const handlers: Record<string, (params: unknown[]) => unknown> = {
		eth_chainId: () => numberToHex(o.chainId ?? 11_155_111),
		eth_getBlockByNumber: () => ({ hash: o.blockHash ?? TARGET.block.hash, number: "0xba9000" }),
		eth_getStorageAt: ([at, slot]) => storage(at as string, slot),
		eth_getCode: ([a]) => (getAddress(a as string) === addr(0) ? "0x" : codeOf(getAddress(a as string))),
		eth_call: ([c]) => call(c as { to: string; data: string }),
	}
	const rpc: Rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
		const handler = handlers[method]
		if (!handler) throw new Error(`unexpected ${method}`)
		return handler(params) as T
	}
	return { rpc, pins }
}

const BASE: Chain = {
	implementations: { vault: addr(1), entrypoint: addr(11), keystore: addr(12), aspRegistry: addr(13) },
	depositVerifier: addr(2),
	transact1x1Verifier: addr(3),
	transact1x1Selector: "0xc9219a7a",
	rollup: addr(4),
	rollupVersion: 679_261_766n,
	inbox: addr(5),
	outbox: addr(6),
}

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

	test("an upgraded contract fails on the fork and live, naming the field and both values", async () => {
		const { pins } = chain(BASE)
		const upgraded = chain({ ...BASE, implementations: { ...BASE.implementations, keystore: addr(21) } }).rpc
		const onFork = await rejection(checkFork(upgraded, pins))
		expect([onFork.kind, onFork.pins]).toEqual(["pin", ["code.keystore.implementation", "code.keystore.implementationCodeHash"]])
		expect(onFork.message).toContain(`code.keystore.implementation is ${addr(21)}, pinned ${addr(12)}`)
		expect(onFork.message).toContain(
			`code.keystore.implementationCodeHash is ${keccak256(codeOf(addr(21)))}, pinned ${keccak256(codeOf(addr(12)))}`,
		)
		expect((await rejection(checkLive(upgraded, pins))).kind).toBe("live")
	})

	test("a vault wired to another registry fails as wiring, on the fork and live, and is never enrolled", async () => {
		const { pins } = chain(BASE)
		const rewired = chain(BASE, { wiring: { aspRegistry: addr(31) } }).rpc
		const onFork = await rejection(checkFork(rewired, pins))
		expect([onFork.kind, onFork.pins]).toEqual(["pin", ["wiring.vault.aspRegistry"]])
		expect(onFork.message).toContain(`wiring.vault.aspRegistry is ${addr(31)}, the target's is ${pins.pool.aspRegistry}`)
		expect((await rejection(checkLive(rewired, pins))).pins).toEqual(["wiring.vault.aspRegistry"])
		await expect(enroll(rewired, pins, pins.block.number)).rejects.toThrow("refusing to pin block 12224362: wiring.vault.aspRegistry")
	})

	test("enrollment refuses a cleared implementation slot", async () => {
		const { pins } = chain(BASE)
		const cleared = chain({ ...BASE, implementations: { ...BASE.implementations, vault: addr(0) } }).rpc
		await expect(enroll(cleared, pins, pins.block.number)).rejects.toThrow("vault's EIP-1967 slot is empty")
		expect((await enroll(chain(BASE).rpc, pins, pins.block.number)).code).toEqual(pins.bindings.code)
	})

	test("tells an endpoint that no longer serves the block from one whose block differs from the pin", async () => {
		const { pins } = chain(BASE)
		const pruned = await rejection(checkEndpoint(chain(BASE, { pruned: true }).rpc, pins, "rpc.example"))
		expect([pruned.kind, pruned.message]).toEqual(["endpoint", "rpc.example no longer serves block 12224362: missing trie node"])
		const otherHash = await rejection(checkEndpoint(chain(BASE, { blockHash: `0x${"ab".repeat(32)}` }).rpc, pins, "rpc.example"))
		expect([otherHash.kind, otherHash.pins]).toEqual(["pin", ["block.hash"]])
		const mainnet = await rejection(checkEndpoint(chain(BASE, { chainId: 1, pruned: true }).rpc, pins, "rpc.example"))
		expect([mainnet.kind, mainnet.pins]).toEqual(["pin", ["chainId"]])
		const prunedOtherHash = chain(BASE, { blockHash: `0x${"ab".repeat(32)}`, pruned: true }).rpc
		expect((await rejection(checkEndpoint(prunedOtherHash, pins, "rpc.example"))).pins).toEqual(["block.hash"])
		const { rpc: base } = chain(BASE)
		const lagging: Rpc = async <T>(method: string, params: unknown[] = []) =>
			(params[0] === "finalized" ? { number: numberToHex(pins.block.number - 1n) } : await base(method, params)) as T
		const stale = await rejection(checkLive(lagging, pins))
		expect([stale.kind, stale.message]).toEqual([
			"endpoint",
			"the endpoint failed reading the live deployment: its finalized block 12224361 predates the pinned block",
		])
		const down: Rpc = async () => Promise.reject(new Error("HTTP 502"))
		const live = await rejection(checkLive(down, pins))
		expect([live.kind, live.message]).toEqual(["endpoint", "the endpoint failed reading the live deployment: HTTP 502"])
		const forkHash = await rejection(checkFork(chain(BASE, { blockHash: `0x${"cd".repeat(32)}` }).rpc, pins))
		expect([forkHash.kind, forkHash.pins]).toEqual(["pin", ["block.hash"]])
	})

	test("compares addresses and hashes without regard to case", () => {
		const { pins } = chain(BASE)
		const vault = pins.bindings.code.vault
		const lower = {
			...pins.bindings,
			inbox: pins.bindings.inbox.toLowerCase() as Address,
			code: { ...pins.bindings.code, vault: { ...vault, implementation: vault.implementation.toLowerCase() as Address } },
		}
		expect(drifted(lower, pins.bindings)).toEqual([])
	})
})
