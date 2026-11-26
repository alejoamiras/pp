import { Fr } from "@aztec-labs/aztec.js/fields"
import { Contract } from "@aztec-labs/aztec.js/contracts"
import type { TxHash } from "@aztec-labs/aztec.js/tx"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { type Actor, actor, artifact, record, summarizeProfile } from "./helpers"

const L1 = new Fr(0x111n)
const L2 = new Fr(0x222n)

describe("q2 labelled note: discovery without a registered sender", () => {
	let alice: Actor
	let bob: Actor
	let asAlice: Contract
	let asBob: Contract

	const bobBalance = async (label: Fr) =>
		BigInt((await asBob.methods.balance_of(bob.address, label).simulate({ from: bob.address })).result)

	async function effects(txHash: TxHash) {
		const effect = (await alice.node.getTxEffect(txHash))?.data
		if (!effect) throw new Error(`no effect for ${txHash}`)
		return {
			noteHashes: effect.noteHashes.length,
			nullifiers: effect.nullifiers.length,
			privateLogs: effect.privateLogs.length,
			publicLogs: effect.publicLogs.map((l) => l.contractAddress.toString()),
		}
	}

	beforeAll(async () => {
		alice = await actor(inject("nodeUrl"), 0)
		bob = await actor(inject("nodeUrl"), 1)
		const token = artifact("label_token-LabelToken.json")
		const { contract, instance } = await Contract.deploy(alice.wallet, token, [alice.address]).send({ from: alice.address })
		asAlice = contract
		await bob.wallet.registerContract(instance, token)
		asBob = await Contract.at(instance.address, token, bob.wallet)
	})
	afterAll(async () => {
		await alice?.wallet.stop()
		await bob?.wallet.stop()
	})

	it("bob's PXE does not know alice in any way", async () => {
		const accounts = (await bob.wallet.getAccounts()).map((a) => a.item.toString())
		const senders = (await bob.wallet.getAddressBook()).map((a) => a.item.toString())
		expect(accounts).toEqual([bob.address.toString()])
		expect(senders).not.toContain(alice.address.toString())
	})

	it("finds a constrained mint from an unregistered minter, then reuses the handshake", async () => {
		const first = asAlice.methods.mint_private(bob.address, L1, 100n)
		record("q2.mint_constrained.first.gates", summarizeProfile(await first.profile({ from: alice.address, profileMode: "gates" })))
		const r1 = await first.send({ from: alice.address })
		record("q2.mint_constrained.first.effects", await effects(r1.receipt.txHash))
		expect(await bobBalance(L1)).toBe(100n)

		const second = asAlice.methods.mint_private(bob.address, L1, 1n)
		record("q2.mint_constrained.second.gates", summarizeProfile(await second.profile({ from: alice.address, profileMode: "gates" })))
		const r2 = await second.send({ from: alice.address })
		record("q2.mint_constrained.second.effects", await effects(r2.receipt.txHash))
		expect(await bobBalance(L1)).toBe(101n)
	})

	it("control: an address-derived mint stays invisible until bob registers alice", async () => {
		const control = asAlice.methods.mint_private_address_derived(bob.address, L2, 5n)
		record("q2.mint_address_derived.gates", summarizeProfile(await control.profile({ from: alice.address, profileMode: "gates" })))
		await control.send({ from: alice.address })
		expect(await bobBalance(L2)).toBe(0n)

		await bob.wallet.registerSender(alice.address, "alice")
		expect(await bobBalance(L2)).toBe(5n)
		expect(await bobBalance(L1)).toBe(101n)
	})
})
