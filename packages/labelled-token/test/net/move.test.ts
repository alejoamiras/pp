// Checked spends between devices, and anchor-time checks against inclusion-time state: TXE proves
// and includes at one block, so only a live network can move the registry between the two.
import type { Contract } from "@aztec-labs/aztec.js/contracts"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { TxExecutionResult } from "@aztec-labs/aztec.js/tx"
import { createAztecNodeDebugClient } from "@aztec-labs/stdlib/interfaces/client"
import { connectL2, connectPeer, createActor, freshActorSecret, type L2Base, settled } from "@pp/bridge-core/sandbox"
import { beforeAll, describe, expect, inject, test } from "vitest"
import { land, prove } from "./internals"
import { deployRegistry, type Registry, type Tree, tree } from "./registry"
import { attach, balance, type Deployed, type Device, deployStage, labels, publicBalance, sendOpts, values } from "./token"

const L = 0x1abe1n
const ORIGIN_POOL = 0
const SPEND_WINDOW = 1800n
const LIVE = tree([L, 0x2abe1n])
const REVOKED = tree([0x2abe1n])
const BIRTH = tree([0xb1abe1n])
const BIRTH_NEXT = tree([0xb2abe1n])
const nodeUrl = inject("nodeUrl")

type Holder = Device & { stub: Contract; token: Contract }

let base: L2Base
let deployed: Deployed
let registry: Registry
let alice: Holder
let bob: Holder
let racer: Holder
let fresh: Holder
let revertedBlock = 0

async function holder(peer: { wallet: Wallet; fee: Record<string, unknown> }): Promise<Holder> {
	const actor = await createActor(peer.wallet, base.node, peer.fee, freshActorSecret())
	const d = { wallet: peer.wallet, from: actor.address, fee: peer.fee }
	return { ...d, ...(await attach(d, deployed)) }
}

beforeAll(async () => {
	base = await connectL2(nodeUrl)
	const minter = { wallet: base.wallet, from: base.relayer, fee: base.fee }
	registry = await deployRegistry(minter, base.node)
	deployed = await deployStage(minter, registry.address)
	const one = await connectPeer(nodeUrl)
	alice = await holder(one)
	racer = await holder(one)
	fresh = await holder(one)
	bob = await holder(await connectPeer(nodeUrl))
})

const heartbeat = () => registry.post(LIVE.root, BIRTH.root)
const settledBalance = (h: Holder, want: bigint) =>
	settled(
		() => balance(h.token, h.from),
		(v) => v === want,
		`balance ${want}`,
	)
const mint = (h: Holder, amount: bigint) => h.stub.methods.mint(deployed.token.address, h.from, amount, L).send(sendOpts(h) as never)
const transfer = (h: Holder, to: Holder, amount: bigint, pool: Tree = LIVE) =>
	h.token.methods.transfer_private(to.from, amount, L, pool.path(L))
const unshield = (h: Holder, amount: bigint) => h.token.methods.unshield(amount, L, LIVE.path(L))
const ragequit = (h: Holder, amount: bigint) => h.stub.methods.ragequit(deployed.token.address, amount, L)

describe("move: discovery", () => {
	test("Bob finds (L, pool, 20) with no registered sender, Alice keeps (L, pool, 30), and Bob re-spends L", async () => {
		await mint(alice, 50n)
		await settledBalance(alice, 50n)
		await heartbeat()
		await transfer(alice, bob, 20n).send(sendOpts(alice) as never)
		expect(await bob.wallet.getAddressBook()).toEqual([])
		await settledBalance(bob, 20n)
		expect(await labels(bob.token, bob.from)).toEqual([[L, ORIGIN_POOL, 20n]])
		await settledBalance(alice, 30n)
		expect(await labels(alice.token, alice.from)).toEqual([[L, ORIGIN_POOL, 30n]])

		await heartbeat()
		await transfer(bob, alice, 8n).send(sendOpts(bob) as never)
		await settledBalance(bob, 12n)
		await settledBalance(alice, 38n)
	})
})

describe("move: anchor vs inclusion", () => {
	test("a transfer proven before a revoking post lands: its check read the record at its anchor", async () => {
		await heartbeat()
		const proven = await prove(alice, transfer(alice, bob, 10n))
		expect(proven.expirationTimestamp).toBe(proven.anchorTimestamp + SPEND_WINDOW)
		await registry.post(REVOKED.root, BIRTH.root)
		expect((await land(base.node, proven)).executionResult).toBe(TxExecutionResult.SUCCESS)
		await settledBalance(bob, 22n)
		await expect(transfer(alice, bob, 1n).simulate({ from: alice.from } as never)).rejects.toThrow(/NotMember/)
	})

	test("an unshield reverts when only birth_root changes; its notes stay spendable, but only in exact chunks until the revert is final", async () => {
		await mint(racer, 40n)
		await mint(racer, 20n)
		await settledBalance(racer, 60n)
		const t = await heartbeat()
		const proven = await prove(racer, unshield(racer, 15n))
		const calls = proven.tx.getPublicCallRequestsWithCalldata().filter((c) => c.request.contractAddress.equals(deployed.token.address))
		// `finish_unshield(owner, amount, roots)` after the selector: both trees of the anchored record,
		// each with its time, and never the origin.
		expect(calls.map((c) => c.calldata.slice(1).map((f) => f.toBigInt()))).toEqual([
			[racer.from.toBigInt(), 15n, LIVE.root, t, BIRTH.root, t],
		])
		// The node reports an assertion without its message: the same bytes passing before the post
		// and failing after it tie the revert to the new birth root.
		expect((await base.node.simulatePublicCalls(proven.tx, false)).revertReason).toBeUndefined()
		await registry.post(LIVE.root, BIRTH_NEXT.root)
		expect((await base.node.simulatePublicCalls(proven.tx, false)).revertReason?.message).toMatch(/^Assertion failed/)
		const receipt = await land(base.node, proven)
		expect(receipt.executionResult).toBe(TxExecutionResult.REVERTED)
		revertedBlock = Number(receipt.blockNumber)
		expect(await publicBalance(racer.token, racer.from)).toBe(0n)
		expect(await values(racer.token, racer.from, L)).toEqual([40n, 20n])

		// The revert dropped the change note's sequence nullifier, which the next self-send must prove.
		// On an attached network another client's blocks may already have made the revert final.
		if (inject("ownsNetwork")) {
			await expect(ragequit(racer, 10n).send(sendOpts(racer) as never)).rejects.toThrow(/reading an unknown nullifier/)
		}
		await ragequit(racer, 40n).send(sendOpts(racer) as never)
		await settledBalance(racer, 20n)
	})

	test("an unshield lands after a heartbeat re-post of the same roots, and after A→B→A", async () => {
		await mint(fresh, 30n)
		await settledBalance(fresh, 30n)
		await heartbeat()
		const held = await prove(fresh, unshield(fresh, 10n))
		await heartbeat()
		expect((await land(base.node, held)).executionResult).toBe(TxExecutionResult.SUCCESS)
		expect(await publicBalance(fresh.token, fresh.from)).toBe(10n)

		await heartbeat()
		const aba = await prove(fresh, unshield(fresh, 5n))
		await registry.post(REVOKED.root, BIRTH.root)
		await heartbeat()
		expect((await land(base.node, aba)).executionResult).toBe(TxExecutionResult.SUCCESS)
		expect(await publicBalance(fresh.token, fresh.from)).toBe(15n)
		await settledBalance(fresh, 15n)
	})

	test("once the reverted unshield is final, its sender's change-making send lands again", async () => {
		// The idle network finalizes nothing until more blocks arrive; each heartbeat post mines one.
		for (let i = 0; i < 10 && Number(await base.node.getBlockNumber("finalized")) < revertedBlock; i++) await heartbeat()
		expect(Number(await base.node.getBlockNumber("finalized"))).toBeGreaterThanOrEqual(revertedBlock)
		await ragequit(racer, 5n).send(sendOpts(racer) as never)
		await settledBalance(racer, 15n)
	})
})

// Last: the warp cannot be undone, and an attached network's clock belongs to someone else.
describe("move: expiry", () => {
	test.skipIf(!inject("ownsNetwork"))("a proof held past anchor + 1800 s is refused at submission", async () => {
		await heartbeat()
		const proven = await prove(fresh, transfer(fresh, bob, 1n))
		await createAztecNodeDebugClient(nodeUrl).warpL2TimeAtLeastTo(Number(proven.expirationTimestamp) + 1)
		const error = await base.node.sendTx(proven.tx).then(
			() => null,
			(e: Error) => e.message,
		)
		expect(error).toMatch(/Invalid expiration timestamp/)
	})
})
