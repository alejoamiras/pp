// Shields between devices: only the intake's own device can read an announcement, and the public debit
// and nullifiers come from the chain. TXE shares one key store and returns no public data.
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Contract } from "@aztec-labs/aztec.js/contracts"
import { TxExecutionResult } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { birthId, birthLabel, siloedBirthNullifier } from "@pp/bridge-spec/birth"
import {
	actorAccount,
	actorAddress,
	connectL2,
	connectPeer,
	createActor,
	freshActorSecret,
	type L2Base,
	settled,
} from "@pp/bridge-core/sandbox"
import { beforeAll, describe, expect, inject, test } from "vitest"
import { labelledTokenArtifact } from "../../src/index"
import { announcements, nullifiersOf, type Shielded, shield, shieldDebits } from "./births"
import { land, prove } from "./internals"
import { deployRegistry, type Registry, type Tree, tree } from "./registry"
import { attach, balance, type Deployed, type Device, deployStage, labels, publicBalance, sendOpts, values } from "./token"

const L = 0x1abe1n
const ORIGIN_BIRTH = 1
const SPEND_WINDOW = 1800n
const LIVE = tree([L])
const LIVE_NEXT = tree([L, 0x2abe1n])
const BIRTH = tree([0xb1abe1n])
const nodeUrl = inject("nodeUrl")

type Holder = Device & { stub: Contract; token: Contract }
type Desk = { wallet: Wallet; address: AztecAddress }

let base: L2Base
let deployed: Deployed
let registry: Registry
let alice: Holder
let bob: Holder
let carol: Holder
const intakeSecret = freshActorSecret()
const nextIntakeSecret = freshActorSecret()
let intake: AztecAddress
let nextIntake: AztecAddress
let desk: Desk
let birthRoot = BIRTH.root
/** Alice's first birth, which later cases get approved and spend. */
let born: { label: bigint; secret: bigint }

async function holder(peer: { wallet: Wallet; fee: Record<string, unknown> }): Promise<Holder> {
	const actor = await createActor(peer.wallet, base.node, peer.fee, freshActorSecret())
	const d = { wallet: peer.wallet, from: actor.address, fee: peer.fee }
	return { ...d, ...(await attach(d, deployed)) }
}

/** A device that holds only an intake's keys and the token's public instance, started now. */
async function intakeDevice(secret: ReturnType<typeof freshActorSecret>): Promise<Desk> {
	const peer = await connectPeer(nodeUrl)
	const { address } = await actorAccount(peer.wallet, secret)
	await peer.wallet.registerContract(deployed.token, labelledTokenArtifact)
	return { wallet: peer.wallet, address }
}

const heartbeat = () => registry.post(LIVE.root, birthRoot)
const settledPublic = (h: Holder, want: bigint) =>
	settled(
		() => publicBalance(h.token, h.from),
		(v) => v === want,
		`public balance ${want}`,
	)
const received = (d: Desk, n: number) =>
	settled(
		() => announcements(d.wallet, deployed.token.address, d.address),
		(v) => v.length >= n,
		`${n} announcements`,
	)

/** `h` holds `amount` publicly, unshielded from a pool note; `change` stays private. */
async function fund(h: Holder, amount: bigint, change: bigint) {
	await h.stub.methods.mint(deployed.token.address, h.from, amount + change, L).send(sendOpts(h) as never)
	await settled(
		() => balance(h.token, h.from),
		(v) => v === amount + change,
		"the minted note",
	)
	await heartbeat()
	await h.token.methods.unshield(amount, L, LIVE.path(L)).send(sendOpts(h) as never)
	await settledPublic(h, amount)
}

/** A shield that must land, with the expiry every shield sets. */
async function landShield(h: Holder, amount: bigint): Promise<Shielded> {
	const s = await shield(h, base.node, amount)
	expect(s.proven.expirationTimestamp).toBe(s.proven.anchorTimestamp + SPEND_WINDOW)
	expect(s.receipt.executionResult).toBe(TxExecutionResult.SUCCESS)
	return s
}

beforeAll(async () => {
	base = await connectL2(nodeUrl)
	const admin = { wallet: base.wallet, from: base.relayer, fee: base.fee }
	registry = await deployRegistry(admin, base.node)
	deployed = await deployStage(admin, registry.address)
	intake = await actorAddress(base.wallet, intakeSecret)
	nextIntake = await actorAddress(base.wallet, nextIntakeSecret)
	await registry.setIntake(intake)
	const one = await connectPeer(nodeUrl)
	alice = await holder(one)
	carol = await holder(one)
	bob = await holder(await connectPeer(nodeUrl))
	await fund(alice, 60n, 40n)
	await fund(bob, 40n, 0n)
	await fund(carol, 10n, 0n)
})

describe("births", () => {
	test("an intake device started after the shield finds the announcement; label′, birth_id and the nullifier recompute in TS", async () => {
		const { receipt } = await landShield(alice, 25n)
		desk = await intakeDevice(intakeSecret)
		expect(await desk.wallet.getAddressBook()).toEqual([])
		const [a] = await received(desk, 1)
		if (!a) throw new Error("no announcement")
		expect([a.owner.toString(), a.amount, a.txHash.toString()]).toEqual([alice.from.toString(), 25n, receipt.txHash.toString()])
		const token = deployed.token.address
		const label = birthLabel({ token, owner: alice.from, amount: 25n, birthSecret: a.secret })
		expect(a.label).toBe(label)
		const debits = await shieldDebits(base.node, token, receipt.txHash)
		expect(debits.map((d) => [d.birthId, d.owner.toString(), d.amount])).toEqual([
			[birthId({ label, birthSecret: a.secret }), alice.from.toString(), 25n],
		])
		expect(await nullifiersOf(base.node, receipt.txHash)).toContain(
			await siloedBirthNullifier({ token, owner: alice.from, birthSecret: a.secret }),
		)
		expect(await publicBalance(alice.token, alice.from)).toBe(35n)
		await settled(
			() => labels(alice.token, alice.from),
			(v) => v.some(([l, o, b]) => l === label && o === ORIGIN_BIRTH && b === 25n),
			"the birth note",
		)
		born = { label, secret: a.secret }
	})

	test("a shield over the public balance reverts and leaves no note, announcement or birth nullifier", async () => {
		const { receipt } = await shield(carol, base.node, 15n)
		expect(receipt.executionResult).toBe(TxExecutionResult.REVERTED)
		const effect = await base.node.getTxEffect(receipt.txHash)
		// Only the tx's own nullifier survives: no birth nullifier, no note, no delivered message.
		expect([effect?.data.nullifiers.length, effect?.data.noteHashes.length, effect?.data.privateLogs.length]).toEqual([1, 0, 0])
		expect(await publicBalance(carol.token, carol.from)).toBe(10n)
		expect(await labels(carol.token, carol.from)).toEqual([])
		expect((await announcements(desk.wallet, deployed.token.address, intake)).length).toBe(1)

		// Each constrained delivery proves its predecessor's sequence nullifier, which the revert dropped,
		// so the owner's next one fails until the revert is final. An attached network may be there.
		if (inject("ownsNetwork")) {
			await expect(carol.token.methods.shield(5n).send(sendOpts(carol) as never)).rejects.toThrow(/reading an unknown nullifier/)
		}
		const reverted = Number(receipt.blockNumber)
		for (let i = 0; i < 10 && Number(await base.node.getBlockNumber("finalized")) < reverted; i++) await heartbeat()
		expect(Number(await base.node.getBlockNumber("finalized"))).toBeGreaterThanOrEqual(reverted)
		await landShield(carol, 5n)
		expect(await publicBalance(carol.token, carol.from)).toBe(5n)
	})

	test("after the intake moves, a new shield announces only to the new intake, and one proven before the move to the old", async () => {
		const early = await prove(bob, bob.token.methods.shield(6n))
		expect(early.expirationTimestamp).toBe(early.anchorTimestamp + SPEND_WINDOW)
		await registry.setIntake(nextIntake)
		await landShield(alice, 7n)
		expect((await land(base.node, early)).executionResult).toBe(TxExecutionResult.SUCCESS)
		const next = await intakeDevice(nextIntakeSecret)
		const toNext = await received(next, 1)
		const toOld = await received(desk, 3)
		const seen = (xs: { owner: AztecAddress; amount: bigint }[]) => xs.map((x) => [x.owner.toString(), x.amount])
		expect(seen(toNext)).toEqual([[alice.from.toString(), 7n]])
		expect(seen(toOld)).toEqual([
			[alice.from.toString(), 25n],
			[carol.from.toString(), 5n],
			[bob.from.toString(), 6n],
		])
	})
})

describe("births: approval", () => {
	let approved: Tree

	test("a birth label spends only once the birth tree admits it, and then pays another device", async () => {
		approved = tree([born.label, 0xb1abe1n])
		await heartbeat()
		const pay = () => alice.token.methods.transfer_private(bob.from, 10n, born.label, approved.path(born.label))
		await expect(pay().simulate({ from: alice.from } as never)).rejects.toThrow(/NotMember/)
		birthRoot = approved.root
		await heartbeat()
		await pay().send(sendOpts(alice) as never)
		await settled(
			() => values(bob.token, bob.from, born.label),
			(v) => v.length === 1 && v[0] === 10n,
			"bob's birth note",
		)
		expect(await labels(bob.token, bob.from)).toContainEqual([born.label, ORIGIN_BIRTH, 10n])
		expect(await values(alice.token, alice.from, born.label)).toEqual([15n])
	})

	test("a birth-note unshield reverts when only pool_root changes, and its note stays spendable", async () => {
		await heartbeat()
		const proven = await prove(bob, bob.token.methods.unshield(4n, born.label, approved.path(born.label)))
		expect((await base.node.simulatePublicCalls(proven.tx, false)).revertReason).toBeUndefined()
		await registry.post(LIVE_NEXT.root, birthRoot)
		expect((await land(base.node, proven)).executionResult).toBe(TxExecutionResult.REVERTED)
		expect(await publicBalance(bob.token, bob.from)).toBe(34n)
		expect(await values(bob.token, bob.from, born.label)).toEqual([10n])
		// An exact chunk delivers no change, so the dropped sequence nullifier does not block it.
		await bob.token.methods.unshield(10n, born.label, approved.path(born.label)).send(sendOpts(bob) as never)
		await settledPublic(bob, 44n)
	})
})
