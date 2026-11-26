import { Contract } from "@aztec-labs/aztec.js/contracts"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { waitForTx } from "@aztec-labs/aztec.js/node"
import { TxExecutionResult } from "@aztec-labs/aztec.js/tx"
import { createAztecNodeDebugClient } from "@aztec-labs/stdlib/interfaces/client"
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest"
import { type Actor, actor, artifact, proveOnly, record, summarizeProfile } from "./helpers"

const MAX_AGE = 3600n
const WINDOW = 1800n

describe("q3 registry read in private", () => {
	let alice: Actor
	let registry: Contract
	let reader: Contract
	let sequence = 0n

	async function post(root: bigint): Promise<bigint> {
		sequence += 1n
		await registry.methods.post_root(sequence, new Fr(root)).send({ from: alice.address })
		return sequence
	}
	const current = async () =>
		(await registry.methods.get_record().simulate({ from: alice.address })).result as { sequence: bigint; root: bigint; time: bigint }

	beforeAll(async () => {
		alice = await actor(inject("nodeUrl"), 0, { proverEnabled: true })
		registry = (await Contract.deploy(alice.wallet, artifact("root_registry-RootRegistry.json"), [alice.address]).send({ from: alice.address }))
			.contract
		reader = (
			await Contract.deploy(alice.wallet, artifact("registry_reader-RegistryReader.json"), [registry.address, MAX_AGE, WINDOW]).send({
				from: alice.address,
			})
		).contract
		await post(0xa1n)
	})
	afterAll(async () => {
		await alice?.wallet.stop()
	})

	it("measures the private read with the real prover", async () => {
		const profile = await reader.methods.check().profile({ from: alice.address, profileMode: "full", skipProofGeneration: false })
		record("q3.check.tx", summarizeProfile(profile))
		const p2 = await reader.methods.check_current().profile({ from: alice.address, profileMode: "full", skipProofGeneration: false })
		record("q3.check_current.tx", summarizeProfile(p2))
	})

	it("baseline: check_current proven and sent at once lands", async () => {
		const proven = await proveOnly(alice, reader.methods.check_current())
		record("q3.expiry", { anchor: proven.anchorTimestamp, expiration: proven.expirationTimestamp, requested: proven.anchorTimestamp + WINDOW })
		expect(proven.expirationTimestamp).toBeLessThanOrEqual(proven.anchorTimestamp + WINDOW)
		await alice.node.sendTx(proven.tx)
		const receipt = await waitForTx(alice.node, proven.tx.getTxHash())
		expect(receipt.executionResult).toBe(TxExecutionResult.SUCCESS)
	})

	it("stale root: a proof made before an update still lands, carrying the old record", async () => {
		const before = await current()
		const proven = await proveOnly(alice, reader.methods.check())
		expect(proven.returnValues).toEqual([before.sequence, before.root, before.time])

		await post(0xb2n)
		const after = await current()
		expect(after.sequence).toBe(before.sequence + 1n)
		expect(after.root).not.toBe(before.root)

		await alice.node.sendTx(proven.tx)
		const receipt = await waitForTx(alice.node, proven.tx.getTxHash())
		expect(receipt.executionResult).toBe(TxExecutionResult.SUCCESS)
		record("q3.stale_root_landed", { provenSequence: before.sequence, currentSequence: after.sequence, fee: receipt.transactionFee })
	})

	it("current check: the same race with check_current reverts in public", async () => {
		const proven = await proveOnly(alice, reader.methods.check_current())
		await post(0xc3n)
		await alice.node.sendTx(proven.tx)
		const receipt = await waitForTx(alice.node, proven.tx.getTxHash(), { dontThrowOnRevert: true })
		expect(receipt.executionResult).toBe(TxExecutionResult.REVERTED)
		record("q3.check_current_reverted", { error: receipt.error ?? null, fee: receipt.transactionFee })
	})

	it("expiry: a proof sent after its expiry is rejected", async () => {
		const proven = await proveOnly(alice, reader.methods.check())
		await createAztecNodeDebugClient(inject("nodeUrl")).warpL2TimeAtLeastTo(Number(proven.expirationTimestamp) + 1)
		const error = await alice.node.sendTx(proven.tx).then(
			() => null,
			(e: Error) => e.message,
		)
		record("q3.expired_send", { expiration: proven.expirationTimestamp, error })
		expect(error).not.toBeNull()
		expect(error?.toLowerCase()).toMatch(/expir|timestamp|include/)
	})
})
