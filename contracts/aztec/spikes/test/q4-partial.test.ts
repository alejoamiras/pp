import { Contract } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { waitForTx } from "@aztec-labs/aztec.js/node"
import { TxExecutionResult, type Tx } from "@aztec-labs/aztec.js/tx"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { type Actor, actor, artifact, proveOnly, pxeTagSources, record, summarizeProfile } from "./helpers"

describe("q4 partial note committing to a private label", () => {
	let alice: Actor
	let bob: Actor
	let carol: Actor
	const token = artifact("label_token-LabelToken.json")
	const at: Record<string, Contract> = {}

	const bobBalance = async (label: Fr) =>
		BigInt((await at.bob!.methods.balance_of(bob.address, label).simulate({ from: bob.address })).result)

	async function landed(who: Actor, tx: Tx) {
		await who.node.sendTx(tx)
		const receipt = await waitForTx(who.node, tx.getTxHash())
		expect(receipt.executionResult).toBe(TxExecutionResult.SUCCESS)
		const effect = (await who.node.getTxEffect(tx.getTxHash()))?.data
		if (!effect) throw new Error("no tx effect")
		return effect
	}

	type Effect = Awaited<ReturnType<typeof landed>>
	/** The published fields searched for the label in plaintext. */
	const published = (e: Effect, calldata: Fr[]) => [
		...calldata,
		...e.privateLogs.flatMap((l) => l.fields),
		...e.publicLogs.flatMap((l) => l.getEmittedFields()),
		...e.nullifiers,
		...e.noteHashes,
		...e.l2ToL1Msgs,
		...e.publicDataWrites.flatMap((w) => [w.leafSlot, w.value]),
	]
	const alicePublic = async () => BigInt((await at.alice!.methods.balance_of_public(alice.address).simulate({ from: alice.address })).result)

	/** Prepares a partial note for bob under `label`, completable by alice, and returns its commitment. */
	async function prepare(by: Actor, label: Fr) {
		const proven = await proveOnly(by, at[by === bob ? "bob" : "carol"]!.methods.prepare_partial(bob.address, label, alice.address))
		const effect = await landed(by, proven.tx)
		expect(published(effect, proven.tx.publicFunctionCalldata.flatMap((c) => c.values)).some((f) => f.equals(label))).toBe(false)
		// Tx and validity nullifiers; a third party's constrained first contact adds the handshake and sequence ones.
		expect(effect.nullifiers.length).toBe(by === bob ? 2 : 4)
		return new Fr(proven.returnValues[0]!)
	}

	/** Alice completes with `amount`; the label must not appear in plaintext anywhere the completion publishes. */
	async function complete(commitment: Fr, label: Fr, amount: bigint) {
		const proven = await proveOnly(alice, at.alice!.methods.complete_partial(commitment, amount))
		const calldata = proven.tx.publicFunctionCalldata.flatMap((c) => c.values)
		const effect = await landed(alice, proven.tx)
		const log = effect.publicLogs.flatMap((l) => l.getEmittedFields())
		// Calldata ends (commitment, amount); the completion log is (tag, slot, amount).
		expect(calldata.slice(1)).toEqual([commitment, new Fr(amount)])
		expect(log).toHaveLength(3)
		expect(log[2]).toEqual(new Fr(amount))
		expect(published(effect, calldata).some((f) => f.equals(label))).toBe(false)
		return effect
	}

	beforeAll(async () => {
		alice = await actor(inject("nodeUrl"), 0)
		bob = await actor(inject("nodeUrl"), 1)
		carol = await actor(inject("nodeUrl"), 2)
		const { contract, instance } = await Contract.deploy(alice.wallet, token, [alice.address]).send({ from: alice.address })
		at.alice = contract
		for (const [name, who] of [["bob", bob], ["carol", carol]] as const) {
			await who.wallet.registerContract(instance, token)
			at[name] = await Contract.at(instance.address, token, who.wallet)
		}
		await at.alice.methods.mint_public(alice.address, 1000n).send({ from: alice.address })
	})
	afterAll(async () => {
		for (const who of [alice, bob, carol]) await who?.wallet.stop()
	})

	it("bob prepares, alice completes in public, bob finds the note under the label; the label never goes public", async () => {
		const label = Fr.random()
		record("q4.prepare_partial.self.gates", summarizeProfile(await at.bob!.methods.prepare_partial(bob.address, label, alice.address).profile({ from: bob.address, profileMode: "gates" })))
		const commitment = await prepare(bob, label)
		const effect = await complete(commitment, label, 40n)
		record("q4.complete_partial.effects", { nullifiers: effect.nullifiers.length, noteHashes: effect.noteHashes.length, publicDataWrites: effect.publicDataWrites.length })
		expect(await bobBalance(label)).toBe(40n)
		expect(await bobBalance(Fr.random())).toBe(0n)

		// A second completion of the same commitment reverts and rolls back its debit and its note.
		const paid = await alicePublic()
		const again = await proveOnly(alice, at.alice!.methods.complete_partial(commitment, 40n))
		await alice.node.sendTx(again.tx)
		const receipt = await waitForTx(alice.node, again.tx.getTxHash(), { dontThrowOnRevert: true })
		expect(receipt.executionResult).toBe(TxExecutionResult.REVERTED)
		expect(await alicePublic()).toBe(paid)
		expect(await bobBalance(label)).toBe(40n)
	})

	it("a third party unknown to bob prepares for him with constrained delivery, and bob finds it", async () => {
		const known = await pxeTagSources(bob)
		expect(known.accounts).toEqual([bob.address.toString()])
		expect(known.senders).not.toContain(carol.address.toString())
		const label = Fr.random()
		record("q4.prepare_partial.third_party.gates", summarizeProfile(await at.carol!.methods.prepare_partial(bob.address, label, alice.address).profile({ from: carol.address, profileMode: "gates" })))
		const commitment = await prepare(carol, label)
		await complete(commitment, label, 25n)
		expect(await bobBalance(label)).toBe(25n)
		expect((await pxeTagSources(bob)).senders).not.toContain(carol.address.toString())
	})
})
