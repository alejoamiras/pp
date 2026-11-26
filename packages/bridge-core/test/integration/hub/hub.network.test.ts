/**
 * The hub on a local network: the claim from a pool withdrawal (N1), the ragequit and its
 * settlement on Ethereum (N2), and every refusal leaving the balance untouched (N3). The cases share
 * one chain and one holder, in order.
 */
import { getPublicEvents } from "@aztec-labs/aztec.js/events"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { type AbiType, decodeFunctionSignature, encodeArguments, EventSelector, type FunctionAbi } from "@aztec-labs/stdlib/abi"
import { computeL2ToL1MessageHash } from "@aztec-labs/stdlib/hash"
import { ragequitContentV1 } from "@pp/bridge-spec"
import type { Address } from "viem"
import { beforeAll, describe, expect, inject, it } from "vitest"
import { tokenBridgeHubArtifact } from "../../../src/artifacts"
import { settled } from "../../../scripts/sandbox/context"
import {
	bootWorld,
	claim,
	consumeAsPortal,
	type Deposit,
	type Holder,
	labelBalance,
	newHolder,
	sendDeposit,
	untilConsumable,
	untilOutboxAccepts,
	type World,
} from "./hub-net"

const PAYEE = "0x000000000000000000000000000000000000bEEF" as Address
const BRIDGED = 100n
const EXITED = 40n

const randomField = () => Fr.random().toBigInt()

async function ticketMetadata() {
	const events = (tokenBridgeHubArtifact.outputs.structs.events ?? []) as (AbiType & { path: string; fields: never[] })[]
	const abiType = events.find((e) => e.path.endsWith("::RagequitTicket"))
	if (!abiType) throw new Error("the hub artifact declares no RagequitTicket")
	return {
		eventSelector: await EventSelector.fromSignature(decodeFunctionSignature("RagequitTicket", abiType.fields)),
		abiType,
		fieldNames: (abiType.fields as { name: string }[]).map((f) => f.name),
	}
}

describe("the hub on a local network", () => {
	let world: World
	let holder: Holder
	let d: Deposit

	beforeAll(async () => {
		world = await bootWorld(inject("hubNetwork"))
		holder = await newHolder(world)
		d = { amount: BRIDGED, nullifier: randomField(), precommitment: randomField(), label: randomField(), claimSalt: randomField() }
	})

	it("N1: register_token publishes the derived token, and the claim's note reaches the claimer's own wallet", async () => {
		expect(await world.base.node.getContract(world.token)).toBeDefined()
		const { leaf, index } = await sendDeposit(world, holder.address, d)
		const beats = await untilConsumable(world, leaf)
		console.log(`N1: the deposit became consumable after ${beats} beat(s)`)
		await claim(holder, world, d, index)
		expect(
			await settled(
				() => labelBalance(holder, d.label),
				(v) => v === BRIDGED,
				"the claimed label balance",
			),
		).toBe(BRIDGED)
	})

	it("N2: the ragequit burns exactly, sends the v1 content, publishes its ticket and settles on Ethereum", async () => {
		const started = Date.now()
		const sent = (await holder.hub.methods
			.ragequit(world.token, EthAddress.fromString(PAYEE), EXITED, new Fr(d.label))
			.send(holder.opts as never)) as unknown as { receipt: { txHash: { toString(): string } } }
		const txHash = sent.receipt.txHash
		const left = BRIDGED - EXITED
		expect(
			await settled(
				() => labelBalance(holder, d.label),
				(v) => v === left,
				"the label balance after the ragequit",
			),
		).toBe(left)

		const content = ragequitContentV1({ payee: PAYEE, amount: EXITED, label: d.label })
		const messageHash = computeL2ToL1MessageHash({
			l2Sender: world.hub,
			l1Recipient: EthAddress.fromString(world.portal.account.address),
			content: new Fr(content),
			rollupVersion: new Fr(world.rollupVersion),
			chainId: new Fr(world.l1ChainId),
		})
		const effect = await world.base.node.getTxEffect(txHash as never)
		if (!effect) throw new Error("the node has no effect for the ragequit")
		expect(effect.data.l2ToL1Msgs.map((m) => m.toString())).toEqual([messageHash.toString()])
		const holderField = holder.address.toField().toString()
		for (const log of effect.data.publicLogs) expect(log.fields.map((f) => f.toString())).not.toContain(holderField)

		const { events } = await getPublicEvents<Record<string, unknown>>(world.base.node, await ticketMetadata(), {
			contractAddress: world.hub,
			txHash: txHash as never,
		})
		expect(events).toHaveLength(1)
		const ticket = events[0]?.event as { token: unknown; payee: unknown; amount: unknown; label: unknown }
		expect(String(ticket.token)).toBe(world.token.toString())
		expect(String(ticket.payee).toLowerCase()).toBe(PAYEE.toLowerCase())
		expect(BigInt(ticket.amount as bigint)).toBe(EXITED)
		expect(BigInt(ticket.label as bigint)).toBe(d.label)

		const acceptance = await untilOutboxAccepts(world, messageHash, txHash)
		const receipt = await consumeAsPortal(world, content, acceptance)
		expect(receipt.status).toBe("success")
		console.log(`N2: Outbox depth ${acceptance.depth}; ragequit to settled ${((Date.now() - started) / 1000).toFixed(1)} s`)
	})

	it("N3: each refused ragequit is rejected by name and leaves the label's balance as it was", async () => {
		const before = await labelBalance(holder, d.label)
		expect(before).toBeGreaterThan(0n)
		const wide = new Fr(2n ** 160n)
		const ragequitAbi = tokenBridgeHubArtifact.functions.find((f) => f.name === "ragequit") as unknown as FunctionAbi
		// aztec.js `EthAddress.fromField` truncates; a raw field reaches the circuit unchanged.
		expect(encodeArguments(ragequitAbi, [world.token, wide, 1n, new Fr(d.label)])[1]?.toBigInt()).toBe(2n ** 160n)
		const cases: [string, unknown, bigint, bigint, RegExp][] = [
			["amount 0", EthAddress.fromString(PAYEE), 0n, d.label, /AmountOutOfRange/],
			["payee 0", EthAddress.ZERO, 1n, d.label, /ZeroPayee/],
			["the portal", EthAddress.fromString(world.portal.account.address), 1n, d.label, /exit payee is the portal/],
			["a payee word of 2^160", wide, 1n, d.label, /PayeeOutOfRange/],
			["label 0", EthAddress.fromString(PAYEE), 1n, 0n, /LabelOutOfRange/],
		]
		for (const [name, payee, amount, label, refusal] of cases) {
			const attempt = holder.hub.methods.ragequit(world.token, payee, amount, new Fr(label)).send(holder.opts as never)
			await expect(attempt, name).rejects.toThrow(refusal)
			expect(await labelBalance(holder, d.label), name).toBe(before)
		}
	})
})
