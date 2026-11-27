import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract"
import { deriveStorageSlotInMap } from "@aztec-labs/stdlib/hash"
import { type Address, getContractAddress, type Hex, keccak256, toHex } from "viem"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { aspRootRegistryArtifact } from "../../src/asp-registry-artifact"
import { hubTokenOfSlot } from "../../src/hub-l2"
import { artifactClassIds, deriveHub } from "../generation"
import {
	checkBeforeOpen,
	type GuardianL1,
	type GuardianWallet,
	type OpenContext,
	OpenRefusedError,
	openDeployedEntries,
	PauseError,
	pauseEntries,
} from "./open"

const CHAIN = 11155111
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address
const w = (n: number) => toHex(BigInt(n), { size: 32 })
const FACTORY = a(0xf0)
const IMPL = getContractAddress({ from: FACTORY, nonce: 1n }).toLowerCase() as Address
const ROLLUP = { l1Registry: a(0x1e), rollup: a(0x10), inbox: a(0x11), outbox: a(0x12), rollupVersion: 7n }
const ASSET = a(0xa5)
const PORTAL = a(0xa6)
const GUARDIAN = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as Address
const REGISTRY = w(0xe9)
const TOKEN = w(0x70)
const ROLES = { admin: w(0xad), poster: w(0xb0), birthIntake: w(0xb1) }
const HEAD = { number: 100n, hash: w(0x100) }

type World = {
	ctx: OpenContext
	l1Reads: Record<string, unknown>
	storage: Map<string, Hex>
	classes: Map<string, string>
	head: { hash: Hex }
	/** The block every L1 contract read named. */
	pins: { blockHash?: Hex; requireCanonical?: boolean }[]
}
let ids: { tokenClassId: string; hubClassId: string; registryClassId: string; hub: Hex }

beforeAll(async () => {
	const { tokenClassId, hubClassId } = await artifactClassIds()
	const registryClassId = (await getContractClassFromArtifact(aspRootRegistryArtifact)).id.toString()
	ids = { tokenClassId, hubClassId, registryClassId, hub: (await deriveHub(tokenClassId, FACTORY, REGISTRY)).address.toString() as Hex }
})

async function world(): Promise<World> {
	const l1Reads: Record<string, unknown> = {
		[`${ROLLUP.l1Registry}.getCanonicalRollup`]: ROLLUP.rollup,
		[`${ROLLUP.rollup}.getInbox`]: ROLLUP.inbox,
		[`${ROLLUP.rollup}.getOutbox`]: ROLLUP.outbox,
		[`${ROLLUP.rollup}.getVersion`]: ROLLUP.rollupVersion,
		[`${FACTORY}.IMPLEMENTATION`]: IMPL,
		[`${FACTORY}.L2_HUB`]: ids.hub,
		[`${FACTORY}.owner`]: GUARDIAN,
		[`${FACTORY}.INBOX`]: ROLLUP.inbox,
		[`${FACTORY}.ROLLUP_VERSION`]: ROLLUP.rollupVersion,
		[`${FACTORY}.portalOf`]: PORTAL,
		[`${FACTORY}.pendingOwner`]: a(0),
		[`${IMPL}.FACTORY`]: FACTORY,
		[`${IMPL}.L2_HUB`]: ids.hub,
		[`${IMPL}.INBOX`]: ROLLUP.inbox,
		[`${IMPL}.OUTBOX`]: ROLLUP.outbox,
		[`${IMPL}.ROLLUP_VERSION`]: ROLLUP.rollupVersion,
		[`${IMPL}.POOL`]: a(0x9001),
		[`${IMPL}.LIFETIME_CAP`]: 10n ** 12n,
		[`${PORTAL}.underlying`]: ASSET,
	}
	const tokenSlot = await deriveStorageSlotInMap(hubTokenOfSlot(), EthAddress.fromString(ASSET))
	const slot = (n: "admin" | "poster" | "birth_intake") => aspRootRegistryArtifact.storageLayout[n]?.slot.toString()
	const storage = new Map<string, Hex>([
		[`${ids.hub}:${tokenSlot.toString()}`, TOKEN],
		[`${REGISTRY}:${slot("admin")}`, ROLES.admin],
		[`${REGISTRY}:${slot("poster")}`, ROLES.poster],
		[`${REGISTRY}:${slot("birth_intake")}`, ROLES.birthIntake],
	])
	const classes = new Map([
		[ids.hub, ids.hubClassId],
		[TOKEN, ids.tokenClassId],
		[REGISTRY, ids.registryClassId],
	])
	const head = { hash: HEAD.hash as Hex }
	const pins: World["pins"] = []
	const ctx: OpenContext = {
		chainId: CHAIN,
		l1: {
			getChainId: async () => CHAIN,
			getBlock: (async (q: { blockTag?: string; blockNumber?: bigint }) => {
				if (q.blockTag && q.blockTag !== "latest") throw new Error(`the open check read ${q.blockTag}`)
				return q.blockTag ? { number: HEAD.number, hash: HEAD.hash } : { number: q.blockNumber, hash: head.hash }
			}) as never,
			readContract: (async (q: { address: string; functionName: string; blockHash?: Hex; requireCanonical?: boolean }) => {
				const key = `${q.address.toLowerCase()}.${q.functionName}`
				if (!(key in l1Reads)) throw new Error(`unexpected read ${key}`)
				pins.push({ blockHash: q.blockHash, requireCanonical: q.requireCanonical })
				return l1Reads[key]
			}) as never,
		},
		node: {
			getNodeInfo: async () => ({
				l1ChainId: CHAIN,
				rollupVersion: Number(ROLLUP.rollupVersion),
				l1ContractAddresses: {
					registryAddress: ROLLUP.l1Registry,
					rollupAddress: ROLLUP.rollup,
					inboxAddress: ROLLUP.inbox,
					outboxAddress: ROLLUP.outbox,
				},
			}),
			getContract: async (addr) => {
				const id = classes.get(addr.toString())
				return id ? { currentContractClassId: { toString: () => id } } : undefined
			},
			getContractClass: async (id) => (id.toString() === ids.tokenClassId ? {} : undefined),
			getPublicStorageAt: async (_b, contract, s) => Fr.fromHexString(storage.get(`${contract.toString()}:${s.toString()}`) ?? w(0)),
		},
		factory: FACTORY,
		portals: [{ asset: ASSET, portal: PORTAL, l2Token: TOKEN }],
		hub: ids.hub,
		registry: REGISTRY,
		expected: { guardian: GUARDIAN, lifetimeCap: 10n ** 12n, pool: a(0x9001), rollup: ROLLUP, registryRoles: ROLES },
	}
	return { ctx, l1Reads, storage, classes, head, pins }
}

const refusedAt = (check: RegExp) => expect.objectContaining({ name: "OpenRefusedError", check: expect.stringMatching(check) })

describe("checkBeforeOpen", () => {
	it("passes a generation that matches every expectation, reading all of L1 at one head's hash", async () => {
		const { ctx, pins } = await world()
		await expect(checkBeforeOpen(ctx)).resolves.toBeUndefined()
		expect(pins.length).toBeGreaterThan(15)
		expect(pins).toEqual(pins.map(() => ({ blockHash: HEAD.hash, requireCanonical: true })))
	})

	it("refuses a registry that moved to a new rollup, even with an older finalized head, and a node on the old one", async () => {
		const moved = await world()
		moved.l1Reads[`${ROLLUP.l1Registry}.getCanonicalRollup`] = a(0x20)
		await expect(checkBeforeOpen(moved.ctx)).rejects.toEqual(refusedAt(/getCanonicalRollup/))
		const stale = await world()
		const info = await stale.ctx.node.getNodeInfo()
		stale.ctx.node.getNodeInfo = async () => ({ ...info, l1ContractAddresses: { ...info.l1ContractAddresses, inboxAddress: a(0x21) } })
		await expect(checkBeforeOpen(stale.ctx)).rejects.toEqual(refusedAt(/node\.inbox/))
	})

	it("refuses another chain on the reader or the node", async () => {
		const reader = await world()
		reader.ctx.l1.getChainId = async () => 1
		await expect(checkBeforeOpen(reader.ctx)).rejects.toEqual(refusedAt(/l1\.chainId/))
		const node = await world()
		const info = await node.ctx.node.getNodeInfo()
		node.ctx.node.getNodeInfo = async () => ({ ...info, l1ChainId: 1 })
		await expect(checkBeforeOpen(node.ctx)).rejects.toEqual(refusedAt(/node\.l1ChainId/))
	})

	it("refuses no portals, a zero registry with roles, other roles, another registry class and a pending owner", async () => {
		const none = await world()
		await expect(checkBeforeOpen({ ...none.ctx, portals: [] })).rejects.toEqual(refusedAt(/portals/))

		const zero = await world()
		const zeroHub = (await deriveHub(ids.tokenClassId, FACTORY, w(0))).address.toString()
		zero.l1Reads[`${FACTORY}.L2_HUB`] = zeroHub
		zero.l1Reads[`${IMPL}.L2_HUB`] = zeroHub
		zero.classes.set(zeroHub, ids.hubClassId)
		const tokenSlot = await deriveStorageSlotInMap(hubTokenOfSlot(), EthAddress.fromString(ASSET))
		zero.storage.set(`${zeroHub}:${tokenSlot.toString()}`, TOKEN)
		const zeroCtx = { ...zero.ctx, hub: zeroHub as Hex, registry: w(0) }
		await expect(checkBeforeOpen(zeroCtx)).rejects.toEqual(refusedAt(/^registry$/))
		const { registryRoles: _, ...noRoles } = zeroCtx.expected
		await expect(checkBeforeOpen({ ...zeroCtx, expected: noRoles })).resolves.toBeUndefined()

		const rotated = await world()
		rotated.ctx.expected.registryRoles = { ...ROLES, poster: w(0xbad) }
		await expect(checkBeforeOpen(rotated.ctx)).rejects.toEqual(refusedAt(/registry\.poster/))

		const otherClass = await world()
		otherClass.classes.set(REGISTRY, ids.tokenClassId)
		await expect(checkBeforeOpen(otherClass.ctx)).rejects.toEqual(refusedAt(/registry class/))

		const pending = await world()
		pending.l1Reads[`${FACTORY}.pendingOwner`] = a(0xbeef)
		await expect(checkBeforeOpen(pending.ctx)).rejects.toEqual(refusedAt(/pendingOwner/))
	})

	it("refuses a hub that is not the factory's derived one, a legacy hub class, a token not bound, and a reorged head", async () => {
		const otherHub = await world()
		await expect(checkBeforeOpen({ ...otherHub.ctx, registry: w(0xe8) })).rejects.toEqual(refusedAt(/hub address/))
		const legacy = await world()
		legacy.classes.set(ids.hub, w(0x1e9))
		await expect(checkBeforeOpen(legacy.ctx)).rejects.toThrow(/v1 class/)
		const unbound = await world()
		await expect(checkBeforeOpen({ ...unbound.ctx, portals: [{ asset: ASSET, portal: PORTAL, l2Token: w(0x71) }] })).rejects.toEqual(
			refusedAt(/token_of/),
		)
		const reorged = await world()
		reorged.head.hash = w(0x101)
		await expect(checkBeforeOpen(reorged.ctx)).rejects.toEqual(refusedAt(/l1 head/))
	})
})

// ─── The guardian's writes, against a scripted chain ─────────────────────────

type Tx = { nonce: number; maxFeePerGas: bigint; hash: Hex; paused: boolean }
type Chain = {
	latest: number
	pending: number
	paused: boolean
	finalized: bigint
	block: bigint
	sent: Tx[]
	receipts: Map<Hex, { status: "success" | "reverted"; blockNumber: bigint; blockHash: Hex; transactionHash: Hex }>
	/** `entriesPaused` after each mined block; a header's hash here is its number. */
	history: { block: bigint; paused: boolean }[]
	/** Receipt reads that miss before a mined receipt shows: a backend behind the one counting nonces. */
	receiptMisses: number
	/** The block each pinned read named, by its hash. */
	pins: Hex[]
	onSend?: (tx: Tx) => void
	sendError?: string
	tick?: () => void
}

function chainOf(init: Partial<Chain> = {}): {
	c: Chain
	l1: GuardianL1
	guardian: GuardianWallet
	mine: (tx: Tx, sameBlock?: boolean) => void
} {
	const c: Chain = {
		latest: 5,
		pending: 5,
		paused: false,
		finalized: 1000n,
		block: 10n,
		sent: [],
		receipts: new Map(),
		history: [],
		receiptMisses: 0,
		pins: [],
		...init,
	}
	const initial = c.paused
	/** `sameBlock` puts `tx` after the previous one in its block. */
	const mine = (tx: Tx, sameBlock = false) => {
		if (!sameBlock) c.block += 1n
		c.receipts.set(tx.hash, { status: "success", blockNumber: c.block, blockHash: w(Number(c.block)), transactionHash: tx.hash })
		c.paused = tx.paused
		c.history.push({ block: c.block, paused: tx.paused })
		c.latest = Math.max(c.latest, tx.nonce + 1)
		c.pending = Math.max(c.pending, c.latest)
	}
	const pausedAt = (hash?: Hex) => {
		if (!hash) return c.paused
		c.pins.push(hash)
		return c.history.findLast((s) => s.block <= BigInt(hash))?.paused ?? initial
	}
	const l1 = {
		getChainId: async () => CHAIN,
		estimateFeesPerGas: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }),
		getTransactionCount: async (q: { blockTag: string }) => {
			c.tick?.()
			return q.blockTag === "pending" ? c.pending : c.latest
		},
		getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
			const r = c.receipts.get(hash)
			if (r && c.receiptMisses > 0) c.receiptMisses -= 1
			else if (r) return r
			throw new Error(`Transaction receipt with hash "${hash}" could not be found.`)
		},
		waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
			const r = c.receipts.get(hash)
			if (!r) throw new Error("timed out")
			return r
		},
		getBlock: async (q: { blockTag?: string; blockNumber?: bigint }) =>
			q.blockTag === "finalized"
				? { number: c.finalized, hash: w(Number(c.finalized)) }
				: { number: q.blockNumber ?? c.block, hash: w(Number(q.blockNumber ?? c.block)) },
		readContract: async (q: { blockHash?: Hex }) => pausedAt(q.blockHash),
	} as unknown as GuardianL1
	const guardian = {
		account: { address: GUARDIAN, type: "local" },
		chain: { id: CHAIN },
		getChainId: async () => CHAIN,
		prepareTransactionRequest: async (r: { nonce?: number; maxFeePerGas?: bigint; data: Hex }) => ({
			...r,
			nonce: r.nonce ?? c.latest,
			maxFeePerGas: r.maxFeePerGas ?? 100n,
		}),
		signTransaction: async (r: { nonce: number; maxFeePerGas: bigint; data: Hex }) =>
			toHex(`${r.nonce}:${r.maxFeePerGas}:${r.data}`) as Hex,
		sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
			if (c.sendError) throw new Error(c.sendError)
			const [nonce, fee, data] = Buffer.from(serializedTransaction.slice(2), "hex").toString().split(":")
			const tx = {
				nonce: Number(nonce),
				maxFeePerGas: BigInt(fee as string),
				hash: keccak256(serializedTransaction),
				paused: data?.endsWith("1") ?? false,
			}
			c.sent.push(tx)
			if (c.onSend) c.onSend(tx)
			else mine(tx)
			return tx.hash
		},
	} as unknown as GuardianWallet
	return { c, l1, guardian, mine }
}

const FAST = { timing: { receiptTimeoutMs: 50, pollingIntervalMs: 1 }, waits: { stallMs: 20, finalityMs: 20 } }
const target = (l1: GuardianL1) => ({ chainId: CHAIN, l1, factory: FACTORY })

describe("pauseEntries", () => {
	it("writes even when already paused, at twice the estimate, and waits for finality", async () => {
		const { c, l1, guardian } = chainOf({ paused: true })
		const signed: number[] = []
		const r = await pauseEntries(target(l1), guardian, { ...FAST, onSigned: (s) => signed.push(s.nonce) })
		expect(r).toMatchObject({ nonce: 5, wasPaused: true })
		expect(signed).toEqual([5])
		expect(c.sent).toMatchObject([{ nonce: 5, maxFeePerGas: 200n, paused: true }])
	})

	it("queues after an open still pending, so the open cannot land after it", async () => {
		const { c, l1, guardian } = chainOf({ pending: 6 })
		const r = await pauseEntries(target(l1), guardian, FAST)
		expect(r.nonce).toBe(6)
		expect(c.paused).toBe(true)
	})

	it("re-reads and resends when another transaction takes its nonce, and names the last nonce once three sends lost theirs", async () => {
		const { c, l1, guardian, mine } = chainOf()
		const takenBy = (tx: Tx) => {
			c.latest = tx.nonce + 1 // a hidden open mined at this nonce instead
			c.pending = c.latest
		}
		let first = true
		c.onSend = (tx) => {
			if (!first) return mine(tx)
			first = false
			takenBy(tx)
		}
		const r = await pauseEntries(target(l1), guardian, FAST)
		expect(c.sent.map((t) => t.nonce)).toEqual([5, 6])
		expect(r.nonce).toBe(6)

		const lost = chainOf()
		lost.c.onSend = (tx) => {
			lost.c.latest = tx.nonce + 1
			lost.c.pending = lost.c.latest
		}
		await expect(pauseEntries(target(lost.l1), lost.guardian, FAST)).rejects.toMatchObject({ code: "PAUSE_UNCONFIRMED", nonce: 7 })
		expect(lost.c.sent.map((t) => t.nonce)).toEqual([5, 6, 7])
	})

	it("takes its own receipt for a rejected duplicate before buying another pause, though the receipt shows late", async () => {
		const { c, l1, guardian, mine } = chainOf({ receiptMisses: 2 })
		c.onSend = (tx) => {
			mine(tx)
			c.sendError = "nonce too low" // the same signed pause, mined before this broadcast's answer
		}
		const send = guardian.sendRawTransaction
		guardian.sendRawTransaction = (async (q: never) => {
			await send(q)
			throw new Error(c.sendError)
		}) as never
		const r = await pauseEntries(target(l1), guardian, FAST)
		expect(c.sent.map((t) => t.nonce)).toEqual([5])
		expect(r.nonce).toBe(5)
	})

	it("pauses again when an open queued behind the gap it filled mines after it, reading each state at a header's hash", async () => {
		const { c, l1, guardian, mine } = chainOf()
		let first = true
		c.onSend = (tx) => {
			mine(tx)
			if (!first) return
			first = false
			mine({ nonce: tx.nonce + 1, maxFeePerGas: 100n, hash: w(0x0e), paused: false })
		}
		const r = await pauseEntries(target(l1), guardian, FAST)
		expect(c.sent.map((t) => t.nonce)).toEqual([5, 7])
		expect(r.nonce).toBe(7)
		expect(c.paused).toBe(true)
		expect(c.pins.length).toBeGreaterThan(0)

		// The queued open runs right after the pause in the pause's own block.
		const sameBlock = chainOf()
		let once = true
		sameBlock.c.onSend = (tx) => {
			sameBlock.mine(tx)
			if (!once) return
			once = false
			sameBlock.mine({ nonce: tx.nonce + 1, maxFeePerGas: 100n, hash: w(0x0e), paused: false }, true)
		}
		expect(await pauseEntries(target(sameBlock.l1), sameBlock.guardian, FAST)).toMatchObject({ nonce: 7 })

		const reopening = chainOf()
		reopening.c.onSend = (tx) => {
			reopening.mine(tx)
			reopening.mine({ nonce: tx.nonce + 1, maxFeePerGas: 100n, hash: w(0x0e + tx.nonce), paused: false })
		}
		await expect(pauseEntries(target(reopening.l1), reopening.guardian, FAST)).rejects.toMatchObject({
			code: "PAUSE_UNCONFIRMED",
			nonce: 9,
			message: expect.stringMatching(/reopened/),
		})
	})

	it("names the send as PAUSE_UNCONFIRMED when a read after its receipt fails", async () => {
		const { c, l1, guardian } = chainOf()
		;(l1 as { getBlock: unknown }).getBlock = async () => {
			throw new Error("block not found: hash 0x01")
		}
		const e = await pauseEntries(target(l1), guardian, FAST).catch((x: unknown) => x)
		expect(c.sent).toHaveLength(1)
		expect(e).toMatchObject({ code: "PAUSE_UNCONFIRMED", nonce: 5, message: expect.stringContaining(c.sent[0]!.hash) })
	})

	it("names a nonce gap, a stalled next nonce and an occupied nonce for the owner, and replaces at four times", async () => {
		const gap = chainOf()
		gap.c.onSend = () => {}
		await expect(pauseEntries(target(gap.l1), gap.guardian, { ...FAST, nonce: 7 })).rejects.toMatchObject({
			code: "PAUSE_BLOCKED",
			nonce: 5,
		})
		const stalled = chainOf()
		stalled.c.onSend = () => {}
		await expect(pauseEntries(target(stalled.l1), stalled.guardian, FAST)).rejects.toMatchObject({ code: "PAUSE_STALLED", nonce: 5 })
		const occupied = chainOf({ sendError: "replacement transaction underpriced" })
		await expect(pauseEntries(target(occupied.l1), occupied.guardian, FAST)).rejects.toMatchObject({
			code: "PAUSE_NONCE_OCCUPIED",
			nonce: 5,
		})
		const replace = chainOf()
		await pauseEntries(target(replace.l1), replace.guardian, { ...FAST, nonce: 5, replace: true })
		expect(replace.c.sent[0]?.maxFeePerGas).toBe(400n)
	})

	it("fails PAUSE_UNFINALIZED when finality never reaches the receipt, and refuses another chain before signing", async () => {
		const late = chainOf({ finalized: 0n })
		await expect(pauseEntries(target(late.l1), late.guardian, FAST)).rejects.toBeInstanceOf(PauseError)
		await expect(pauseEntries(target(late.l1), late.guardian, FAST)).rejects.toMatchObject({ code: "PAUSE_UNFINALIZED" })
		const other = chainOf()
		await expect(pauseEntries({ ...target(other.l1), chainId: 1 }, other.guardian, FAST)).rejects.toBeInstanceOf(OpenRefusedError)
		expect(other.c.sent).toEqual([])
	})
})

describe("openDeployedEntries", () => {
	it("refuses with nothing signed: no roles, a portal without its token, another account, another wallet chain", async () => {
		const base = (await world()).ctx
		const { c, l1, guardian } = chainOf({ paused: true })
		const ctx = { ...base, l1: { ...l1, ...base.l1 } as GuardianL1 }
		const { registryRoles: _, ...noRoles } = ctx.expected
		await expect(openDeployedEntries({ ...ctx, expected: noRoles }, guardian, FAST)).rejects.toEqual(refusedAt(/registryRoles/))
		await expect(openDeployedEntries({ ...ctx, portals: [{ asset: ASSET, portal: PORTAL }] }, guardian, FAST)).rejects.toEqual(
			refusedAt(/portals/),
		)
		await expect(openDeployedEntries({ ...ctx, expected: { ...ctx.expected, guardian: a(0x99) } }, guardian, FAST)).rejects.toEqual(
			refusedAt(/^guardian$/),
		)
		await expect(openDeployedEntries(ctx, { ...guardian, getChainId: async () => 1 } as GuardianWallet, FAST)).rejects.toEqual(
			refusedAt(/wallet\.chainId/),
		)
		expect(c.sent).toEqual([])
	})

	it("reports the signed hash before broadcasting and opens", async () => {
		const base = (await world()).ctx
		const { c, l1, guardian } = chainOf({ paused: true })
		const reads = base.l1.readContract
		const ctx = {
			...base,
			l1: {
				...l1,
				...base.l1,
				readContract: (async (q: { functionName: string }) =>
					q.functionName === "entriesPaused" ? c.paused : reads(q as never)) as GuardianL1["readContract"],
			} as GuardianL1,
		}
		const order: string[] = []
		const send = guardian.sendRawTransaction
		guardian.sendRawTransaction = (async (q: never) => {
			order.push("broadcast")
			return send(q)
		}) as never
		const hash = await openDeployedEntries(ctx, guardian, { ...FAST, onSigned: () => order.push("signed") })
		expect(order).toEqual(["signed", "broadcast"])
		expect(hash).toBe(c.sent[0]?.hash)
		expect(c.paused).toBe(false)
	})

	it.each([
		["the registry moved", `${ROLLUP.l1Registry}.getCanonicalRollup`, a(0x20), /getCanonicalRollup/],
		["an ownership transfer is pending", `${FACTORY}.pendingOwner`, a(0xbeef), /pendingOwner/],
	])("reads again after signing and broadcasts nothing once %s", async (_, key, value, check) => {
		const w0 = await world()
		const { c, l1, guardian } = chainOf({ paused: true })
		const ctx = { ...w0.ctx, l1: { ...l1, ...w0.ctx.l1 } as GuardianL1 }
		const sign = guardian.signTransaction
		guardian.signTransaction = (async (q: never) => {
			w0.l1Reads[key] = value
			return sign(q)
		}) as never
		const signed = vi.fn()
		await expect(openDeployedEntries(ctx, guardian, { ...FAST, onSigned: signed })).rejects.toEqual(refusedAt(check))
		expect(signed).not.toHaveBeenCalled()
		expect(c.sent).toEqual([])
	})

	it("refuses another transaction's receipt at its nonce, even one that opened entries", async () => {
		const base = (await world()).ctx
		const { c, l1, guardian } = chainOf({ paused: true })
		const reads = base.l1.readContract
		const ctx = {
			...base,
			l1: {
				...l1,
				...base.l1,
				readContract: (async (q: { functionName: string }) =>
					q.functionName === "entriesPaused" ? c.paused : reads(q as never)) as GuardianL1["readContract"],
				waitForTransactionReceipt: (async ({ hash }: { hash: Hex }) => ({
					...c.receipts.get(hash),
					transactionHash: w(0xab),
				})) as never,
			} as GuardianL1,
		}
		await expect(openDeployedEntries(ctx, guardian, FAST)).rejects.toThrow(/mined at this open's nonce instead/)
	})
})
