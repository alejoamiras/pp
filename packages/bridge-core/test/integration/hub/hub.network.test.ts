/**
 * The hub on a local network: the claim from a pool withdrawal (N1), the ragequit and its message
 * consumed from the real Outbox (N2), each refusal reaching a wallet by name before anything is sent
 * (N3), the same two for the public exit after an unshield (N4, N5), and the private exit's phase guard
 * and its public currency check (N7, N6). The cases share one chain and one holder, in order.
 */
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { getPublicEvents } from "@aztec-labs/aztec.js/events"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import type { FeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { TxExecutionResult } from "@aztec-labs/aztec.js/tx"
import { type AbiType, decodeFunctionSignature, encodeArguments, EventSelector, type FunctionAbi } from "@aztec-labs/stdlib/abi"
import { computeL2ToL1MessageHash } from "@aztec-labs/stdlib/hash"
import { aspLeaf, buildLeanImt, exitContentV1, ragequitContentV1 } from "@pp/bridge-spec"
import type { Address } from "viem"
import { beforeAll, describe, expect, inject, it } from "vitest"
import { labelledTokenArtifact, tokenBridgeHubArtifact } from "../../../src/artifacts"
import { settled } from "../../../scripts/sandbox/context"
import {
	bootWorld,
	claim,
	consumeAsPortal,
	type Deposit,
	exitPrivate,
	type Holder,
	labelBalance,
	newHolder,
	postRoots,
	proverOf,
	publicBalance,
	sendDeposit,
	unshield,
	untilConsumable,
	untilOutboxAccepts,
	type World,
} from "./hub-net"
import { publicCallsOf, selectorOf } from "../public-calls"
import { land, prove, runInSetup } from "../wallet-internals"

const PAYEE = "0x000000000000000000000000000000000000bEEF" as Address
const BRIDGED = 100n
const EXITED = 40n
const UNSHIELDED = 25n
const EXITED_PUBLICLY = 10n
const EXITED_PRIVATELY = 15n
const SPEND_WINDOW = 1800n

const randomField = () => Fr.random().toBigInt()

type TxHash = { toString(): string }

async function ticketMetadata(name: "RagequitTicket" | "PublicExitTicket") {
	const events = (tokenBridgeHubArtifact.outputs.structs.events ?? []) as (AbiType & { path: string; fields: never[] })[]
	const abiType = events.find((e) => e.path.endsWith(`::${name}`))
	if (!abiType) throw new Error(`the hub artifact declares no ${name}`)
	return {
		eventSelector: await EventSelector.fromSignature(decodeFunctionSignature(name, abiType.fields)),
		abiType,
		fieldNames: (abiType.fields as { name: string }[]).map((f) => f.name),
	}
}

/** The transaction's one public event of `name`, emitted by the hub. */
async function ticketOf(world: World, txHash: TxHash, name: "RagequitTicket" | "PublicExitTicket") {
	const { events } = await getPublicEvents<Record<string, unknown>>(world.base.node, await ticketMetadata(name), {
		contractAddress: world.hub,
		txHash: txHash as never,
	})
	expect(events).toHaveLength(1)
	return events[0]?.event as Record<string, unknown>
}

/**
 * The transaction's only L2→L1 message is the hub's `content` to the portal, and the portal's
 * stand-in consumes it from the real Outbox (the portal's own `settle*` is the Solidity suites').
 * Returns the Outbox depth at which it became provable.
 */
async function consumedFromOutbox(world: World, txHash: TxHash, content: bigint): Promise<number> {
	const messageHash = computeL2ToL1MessageHash({
		l2Sender: world.hub,
		l1Recipient: EthAddress.fromString(world.portal.account.address),
		content: new Fr(content),
		rollupVersion: new Fr(world.rollupVersion),
		chainId: new Fr(world.l1ChainId),
	})
	const effect = await world.base.node.getTxEffect(txHash as never)
	if (!effect) throw new Error("the node has no effect for the exit")
	expect(effect.data.l2ToL1Msgs.map((m) => m.toString())).toEqual([messageHash.toString()])
	const acceptance = await untilOutboxAccepts(world, messageHash, txHash)
	const receipt = await consumeAsPortal(world, content, acceptance)
	expect(receipt.status).toBe("success")
	return acceptance.depth
}

describe("the hub on a local network", () => {
	let world: World
	let holder: Holder
	let d: Deposit
	let roots: { pool: ReturnType<typeof buildLeanImt>; birth: bigint }

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

	it("N2: the ragequit burns exactly, sends the v1 content, publishes its ticket, and the portal consumes it from the real Outbox", async () => {
		const started = Date.now()
		const sent = (await holder.hub.methods
			.ragequit(world.token, EthAddress.fromString(PAYEE), EXITED, new Fr(d.label))
			.send(holder.opts as never)) as unknown as { receipt: { txHash: TxHash } }
		const txHash = sent.receipt.txHash
		const left = BRIDGED - EXITED
		expect(
			await settled(
				() => labelBalance(holder, d.label),
				(v) => v === left,
				"the label balance after the ragequit",
			),
		).toBe(left)

		const effect = await world.base.node.getTxEffect(txHash as never)
		if (!effect) throw new Error("the node has no effect for the ragequit")
		const holderField = holder.address.toField().toString()
		for (const log of effect.data.publicLogs) expect(log.fields.map((f) => f.toString())).not.toContain(holderField)

		const ticket = await ticketOf(world, txHash, "RagequitTicket")
		expect(String(ticket.token)).toBe(world.token.toString())
		expect(String(ticket.payee).toLowerCase()).toBe(PAYEE.toLowerCase())
		expect(BigInt(ticket.amount as bigint)).toBe(EXITED)
		expect(BigInt(ticket.label as bigint)).toBe(d.label)

		const depth = await consumedFromOutbox(world, txHash, ragequitContentV1({ payee: PAYEE, amount: EXITED, label: d.label }))
		console.log(`N2: Outbox depth ${depth}; ragequit to Outbox consume ${((Date.now() - started) / 1000).toFixed(1)} s`)
	})

	it("N3: the wallet refuses each invalid ragequit by name before sending it, and the label's balance stays", async () => {
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

	// The token's burn log names the holder, so unlike N2 this case makes no privacy claim.
	it("N4: after an unshield, the public exit burns exactly, sends the v1 content, publishes its ticket, and the portal consumes it from the real Outbox", async () => {
		roots = { pool: buildLeanImt([aspLeaf(d.label)]), birth: buildLeanImt([aspLeaf(randomField())]).root }
		await postRoots(world, { sequence: 1n, l1Block: 1n }, roots.pool.root, roots.birth)
		await unshield(holder, UNSHIELDED, d.label, roots.pool.path(0))
		expect(
			await settled(
				() => publicBalance(holder),
				(v) => v === UNSHIELDED,
				"the public balance after the unshield",
			),
		).toBe(UNSHIELDED)

		const started = Date.now()
		const sent = (await holder.hub.methods
			.exit_public(world.token, EthAddress.fromString(PAYEE), EXITED_PUBLICLY)
			.send(holder.opts as never)) as unknown as { receipt: { txHash: TxHash } }
		const txHash = sent.receipt.txHash
		const left = UNSHIELDED - EXITED_PUBLICLY
		expect(
			await settled(
				() => publicBalance(holder),
				(v) => v === left,
				"the public balance after the exit",
			),
		).toBe(left)

		const ticket = await ticketOf(world, txHash, "PublicExitTicket")
		expect(String(ticket.token)).toBe(world.token.toString())
		expect(String(ticket.payee).toLowerCase()).toBe(PAYEE.toLowerCase())
		expect(BigInt(ticket.amount as bigint)).toBe(EXITED_PUBLICLY)

		const depth = await consumedFromOutbox(world, txHash, exitContentV1({ payee: PAYEE, amount: EXITED_PUBLICLY }))
		console.log(`N4: Outbox depth ${depth}; public exit to Outbox consume ${((Date.now() - started) / 1000).toFixed(1)} s`)
	})

	it("N5: the wallet refuses each invalid public exit by name before sending it, and the public balance stays", async () => {
		const before = await publicBalance(holder)
		expect(before).toBeGreaterThan(0n)
		const payee = EthAddress.fromString(PAYEE)
		const cases: [string, AztecAddress, unknown, bigint, RegExp][] = [
			["amount 0", world.token, payee, 0n, /AmountOutOfRange/],
			["payee 0", world.token, EthAddress.ZERO, 1n, /ZeroPayee/],
			["the portal", world.token, EthAddress.fromString(world.portal.account.address), 1n, /exit payee is the portal/],
			["a payee word of 2^160", world.token, new Fr(2n ** 160n), 1n, /PayeeOutOfRange/],
			["an unregistered token", AztecAddress.fromBigIntUnsafe(0xdeadn), payee, 1n, /uninitialized PublicImmutable/],
		]
		for (const [name, token, to, amount, refusal] of cases) {
			const attempt = holder.hub.methods.exit_public(token, to, amount).send(holder.opts as never)
			await expect(attempt, name).rejects.toThrow(refusal)
			expect(await publicBalance(holder), name).toBe(before)
		}
	})

	it('N7: the private exit simulates in the app phase, and run ahead of the sponsor it fails with "setup phase"', async () => {
		const exit = exitPrivate(holder, world, EthAddress.fromString(PAYEE), 1n, d.label, roots.pool.path(0))
		// The same call in the app phase simulates, so the phase is the only difference.
		await exit.simulate({ from: holder.address, fee: holder.opts.fee } as never)
		const paid = holder.opts.fee as { paymentMethod: FeePaymentMethod }
		const app = holder.hub.methods.exit_public(world.token, EthAddress.fromString(PAYEE), 1n)
		await expect(
			app.simulate({ from: holder.address, fee: { ...paid, paymentMethod: runInSetup(paid.paymentMethod, exit) } } as never),
		).rejects.toThrow(/setup phase/)
	})

	it("N6: a private exit proven under one record carries no holder in its public calls, and reverts whole once the roots change before inclusion", async () => {
		const before = await labelBalance(holder, d.label)
		expect(before).toBeGreaterThan(EXITED_PRIVATELY)
		// N4 left sequence 1. The same roots again, seen at a later L1 block, give the anchor a known root time.
		const t = await postRoots(world, { sequence: 2n, l1Block: 2n }, roots.pool.root, roots.birth)
		const started = Date.now()
		const proven = await prove(
			proverOf(holder),
			exitPrivate(holder, world, EthAddress.fromString(PAYEE), EXITED_PRIVATELY, d.label, roots.pool.path(0)),
		)
		expect(proven.anchorTimestamp).toBeGreaterThanOrEqual(t)
		expect(proven.expirationTimestamp).toBe(proven.anchorTimestamp + SPEND_WINDOW)

		const calls = publicCallsOf(proven.tx)
		expect(calls).toEqual([
			{
				to: world.token.toString(),
				from: world.token.toString(),
				calldata: [await selectorOf(labelledTokenArtifact, "finish_checked_burn"), roots.pool.root, t, roots.birth, t],
			},
			{
				to: world.hub.toString(),
				from: world.hub.toString(),
				calldata: [
					await selectorOf(tokenBridgeHubArtifact, "_exit_ticket"),
					world.token.toBigInt(),
					BigInt(PAYEE),
					EXITED_PRIVATELY,
				],
			},
		])
		const holderWord = holder.address.toBigInt()
		for (const c of calls) expect([BigInt(c.from), ...c.calldata]).not.toContain(holderWord)

		// The node reports an assertion without its message: the same bytes passing before the post and
		// failing after it tie the revert to the changed root.
		expect((await world.base.node.simulatePublicCalls(proven.tx, false)).revertReason).toBeUndefined()
		await postRoots(world, { sequence: 3n, l1Block: 3n }, roots.pool.root, buildLeanImt([aspLeaf(randomField())]).root)
		expect((await world.base.node.simulatePublicCalls(proven.tx, false)).revertReason?.message).toMatch(/^Assertion failed/)
		const receipt = await land(world.base.node, proven)
		expect(receipt.executionResult).toBe(TxExecutionResult.REVERTED)

		const effect = await world.base.node.getTxEffect(proven.tx.getTxHash())
		if (!effect) throw new Error("the node has no effect for the reverted exit")
		// Only the setup phase lands: the protocol's own nullifier, and no burn, change note or its log.
		expect(effect.data.l2ToL1Msgs).toEqual([])
		expect(effect.data.noteHashes).toEqual([])
		expect(effect.data.privateLogs).toEqual([])
		expect(effect.data.nullifiers).toHaveLength(1)
		expect(effect.data.publicLogs.filter((l) => l.contractAddress.equals(world.hub) || l.contractAddress.equals(world.token))).toEqual(
			[],
		)
		expect(await labelBalance(holder, d.label)).toBe(before)
		console.log(`N6: prove to reverted landing ${((Date.now() - started) / 1000).toFixed(1)} s`)
	})
})
