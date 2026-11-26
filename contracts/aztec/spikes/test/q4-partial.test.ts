import { Contract } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { waitForTx } from "@aztec-labs/aztec.js/node"
import { TxExecutionResult, type Tx } from "@aztec-labs/aztec.js/tx"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { type Actor, actor, artifact, proveOnly, record, summarizeProfile } from "./helpers"

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

	/** Prepares a partial note for bob under `label`, completable by alice, and returns its commitment. */
	async function prepare(by: Actor, label: Fr) {
		const proven = await proveOnly(by, at[by === bob ? "bob" : "carol"]!.methods.prepare_partial(bob.address, label, alice.address))
		const effect = await landed(by, proven.tx)
		const visible = [...effect.privateLogs.flatMap((l) => l.fields), ...effect.nullifiers, ...effect.noteHashes]
		expect(visible.some((f) => f.equals(label))).toBe(false)
		return new Fr(proven.returnValues[0]!)
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

		const completion = await proveOnly(alice, at.alice!.methods.complete_partial(commitment, 40n))
		const calldata = completion.tx.publicFunctionCalldata.flatMap((c) => c.values)
		const effect = await landed(alice, completion.tx)
		const logs = effect.publicLogs.flatMap((l) => l.getEmittedFields())

		expect(calldata.some((f) => f.equals(new Fr(40n)))).toBe(true)
		expect(logs.some((f) => f.equals(new Fr(40n)))).toBe(true)
		expect([...calldata, ...logs, ...effect.nullifiers, ...effect.noteHashes].some((f) => f.equals(label))).toBe(false)
		record("q4.complete_partial.effects", { calldataFields: calldata.length, publicLogFields: logs.length, nullifiers: effect.nullifiers.length, noteHashes: effect.noteHashes.length })

		expect(await bobBalance(label)).toBe(40n)
		expect(await bobBalance(Fr.random())).toBe(0n)
	})

	it("a third party unknown to bob prepares for him with constrained delivery, and bob finds it", async () => {
		expect((await bob.wallet.getAddressBook()).map((a) => a.item.toString())).not.toContain(carol.address.toString())
		const label = Fr.random()
		record("q4.prepare_partial.third_party.gates", summarizeProfile(await at.carol!.methods.prepare_partial(bob.address, label, alice.address).profile({ from: carol.address, profileMode: "gates" })))
		const commitment = await prepare(carol, label)
		await at.alice!.methods.complete_partial(commitment, 25n).send({ from: alice.address })
		expect(await bobBalance(label)).toBe(25n)
	})
})
