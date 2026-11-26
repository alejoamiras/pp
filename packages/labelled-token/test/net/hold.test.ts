/**
 * Stage A end to end on a local network, across separate devices: the bridge stand-in mints to a
 * holder whose own device finds the note with no registered sender, the holder claims to itself and
 * leaves in two burns, and a device restored from the keys alone finds the change.
 */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Contract } from "@aztec-labs/aztec.js/contracts"
import type { Tx } from "@aztec-labs/aztec.js/tx"
import { computeFeePayerBalanceLeafSlot } from "@aztec-labs/protocol-contracts/fee-juice"
import { actorAccount, connectL2, connectPeer, createActor, freshActorSecret, type L2Base, settled } from "@pp/bridge-core/sandbox"
import { beforeAll, describe, expect, inject, test } from "vitest"
import { captureSentTxs } from "./internals"
import { attach, balance, type Deployed, type Device, deployStage, labels, sendOpts, values } from "./token"

const L = 0x1abe1n
const ORIGIN_POOL = 0
const nodeUrl = inject("nodeUrl")
const anvilUrl = inject("anvilUrl")

let node: L2Base["node"]
let minter: Device
let deployed: Deployed
let bridge: { stub: Contract; token: Contract }
let minterSends: Tx[]
let holder: Device
let mine: { stub: Contract; token: Contract }
let secret: `0x${string}`

beforeAll(async () => {
	const base = await connectL2(nodeUrl)
	node = base.node
	minter = { wallet: base.wallet, from: base.relayer, fee: base.fee }
	deployed = await deployStage(minter)
	bridge = await attach(minter, deployed)
	minterSends = captureSentTxs(minter.wallet)
	const peer = await connectPeer(nodeUrl)
	secret = freshActorSecret()
	const actor = await createActor(peer.wallet, base.node, peer.fee, secret)
	holder = { wallet: peer.wallet, from: actor.address, fee: peer.fee }
	mine = await attach(holder, deployed)
})

const settledBalance = (token: Contract, owner: AztecAddress, want: bigint) =>
	settled(
		() => balance(token, owner),
		(v) => v === want,
		`balance ${want}`,
	)

describe("stage A on a local network", () => {
	test("the holder's own device finds a bridge mint with no registered sender", async () => {
		await bridge.stub.methods.mint(deployed.token.address, holder.from, 100n, L).send(sendOpts(minter) as never)
		expect(await holder.wallet.getAddressBook()).toEqual([])
		await settledBalance(mine.token, holder.from, 100n)
		expect(await labels(mine.token, holder.from)).toEqual([[L, ORIGIN_POOL, 100n]])
		expect(await values(mine.token, holder.from, L)).toEqual([100n])
	})

	// The mint is private end to end: the token enqueues nothing public, logs nothing public, and
	// the only public write is the fee payer's Fee Juice balance.
	test("the bridge mint leaves no public trace of the token", async () => {
		const tx = minterSends.at(-1)
		if (!tx) throw new Error("the mint was not captured")
		const token = deployed.token.address
		expect(tx.getPublicCallRequestsWithCalldata().filter((c) => c.request.contractAddress.equals(token))).toEqual([])
		const receipt = await node.getTxReceipt(tx.getTxHash(), { includeTxEffect: true })
		const effect = receipt.txEffect
		if (!effect) throw new Error(`the mint has no landed effects (status ${receipt.status})`)
		expect(effect.publicLogs.filter((l) => l.contractAddress.equals(token))).toEqual([])
		const feeLeaf = await computeFeePayerBalanceLeafSlot(tx.data.feePayer)
		expect(effect.publicDataWrites.length).toBeGreaterThan(0)
		expect(effect.publicDataWrites.every((w) => w.leafSlot.equals(feeLeaf))).toBe(true)
	})

	test("the holder claims to itself, leaves in a partial and an exact burn, and a restored device finds the change", async () => {
		await mine.stub.methods.mint(deployed.token.address, holder.from, 50n, L).send(sendOpts(holder) as never)
		await settledBalance(mine.token, holder.from, 150n)
		// Largest first: 95 spends the 100 note and returns 5 as change.
		await mine.stub.methods.ragequit(deployed.token.address, 95n, L).send(sendOpts(holder) as never)
		await settledBalance(mine.token, holder.from, 55n)
		const [chunk] = await values(mine.token, holder.from, L)
		expect(chunk).toBe(50n)
		await mine.stub.methods.ragequit(deployed.token.address, chunk, L).send(sendOpts(holder) as never)
		await settledBalance(mine.token, holder.from, 5n)

		const restored = await connectPeer(nodeUrl)
		const account = await actorAccount(restored.wallet, secret)
		const again = await attach({ wallet: restored.wallet, from: account.address, fee: restored.fee }, deployed)
		await settledBalance(again.token, account.address, 5n)
		expect(await labels(again.token, account.address)).toEqual([[L, ORIGIN_POOL, 5n]])
	})

	// Local time moves only with blocks, so a test that needs age or expiry must mine.
	test("an idle local network does not age", async () => {
		const l1Block = async () => {
			const r = await fetch(anvilUrl, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["latest", false] }),
			})
			const { result } = (await r.json()) as { result: { number: string; timestamp: string } }
			return { number: BigInt(result.number), timestamp: BigInt(result.timestamp) }
		}
		const l2Block = async () => {
			const b = await node.getBlock("proposed")
			if (!b) throw new Error("the node has no proposed block")
			return { number: BigInt(b.header.globalVariables.blockNumber), timestamp: BigInt(b.header.globalVariables.timestamp) }
		}
		const before = { l1: await l1Block(), l2: await l2Block() }
		await new Promise((r) => setTimeout(r, 20_000))
		const idle = { l1: await l1Block(), l2: await l2Block() }
		expect(idle.l2).toEqual(before.l2)
		await bridge.stub.methods.mint(deployed.token.address, holder.from, 1n, L).send(sendOpts(minter) as never)
		const after = { l1: await l1Block(), l2: await l2Block() }
		console.log(
			`[time] idle 20 s: l1 ${before.l1.number}→${idle.l1.number} (+${idle.l1.timestamp - before.l1.timestamp}s), l2 ${before.l2.number}→${idle.l2.number}; one tx: l1 +${after.l1.number - idle.l1.number} blocks (+${after.l1.timestamp - idle.l1.timestamp}s), l2 +${after.l2.number - idle.l2.number} blocks (+${after.l2.timestamp - idle.l2.timestamp}s)`,
		)
		expect(after.l2.number).toBeGreaterThan(idle.l2.number)
	})
})
