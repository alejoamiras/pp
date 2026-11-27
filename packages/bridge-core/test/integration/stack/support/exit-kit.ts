import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { ExecutionPayload, mergeExecutionPayloads } from "@aztec-labs/stdlib/tx"
import { type Address, erc20Abi } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { afterAll, beforeAll, expect } from "vitest"
import { tokenBridgeHubArtifact } from "../../../../src/artifacts"
import { type BridgeClient, clientIo, createBridgeClient } from "../../../../src/client/bridge-client"
import { namedDeployment, verifyDeployment } from "../../../../src/client/deployment"
import { exitReads } from "../../../../src/client/exits-chain"
import { callPayload, sponsored } from "../../../../src/client/payload"
import { prepareBridgeSpend } from "../../../../src/client/prepare"
import type { BridgeSession } from "../../../../src/client/session"
import { LOCAL_TIMING } from "../../../../src/client/timing"
import type { BridgeReceipt, ExitStatus, ExitTicket } from "../../../../src/client/types"
import { memoryStore } from "../../../../src/test/client-fakes"
import { type Account, account, type Device, device, type Owner, owner, seedOf, send, sender, sessionOf } from "./actors"
import { attached, l1Client } from "./stack"

/** Each status poll waits this long; the heartbeat ticks every 2 s. */
const POLL_MS = 1_000
const STATUS_TIMEOUT_MS = 180_000

/** A fresh payee that holds nothing, so its balance is exactly what settles to it. */
export const freshPayee = (): Address => privateKeyToAccount(generatePrivateKey()).address

/**
 * One payload for several sponsored claims: the first keeps its payment, the rest add their claim
 * calls only, so the account's entrypoint runs one fee call and stays within its five calls.
 */
export function oneTransaction(payloads: readonly ExecutionPayload[]): ExecutionPayload {
	const [first, ...rest] = payloads
	if (!first) throw new Error("no payload")
	const claims = rest.map(
		(p) =>
			new ExecutionPayload(
				p.calls.filter((c) => c.name === "claim_from_pool"),
				[],
				[],
				[],
			),
	)
	return mergeExecutionPayloads([first, ...claims])
}

/** One exit file's setup on the attached stack: a device its hooks start and stop, and the fixtures its cases share. */
export function exitKit(name: string) {
	const m = attached()
	const seed = seedOf(m)
	const chain = l1Client(m)
	const timings: Record<string, number> = {}
	let dev: Device

	beforeAll(async () => {
		dev = await device(m, name)
	})

	afterAll(async () => {
		await dev?.stop()
		console.log(`[${name}] timings ms: ${JSON.stringify(timings)}`)
	})

	const client = (): BridgeClient => createBridgeClient({ manifest: m, journal: memoryStore().store })

	/**
	 * One owner's deposit of `deposit`, bridged as `values` to one fresh account, each bridge spending
	 * the change of the one before, so every bridged note carries the deposit's label. The account
	 * claims them all in one sponsored transaction, after its own sponsored deployment.
	 */
	async function claimed(deposit: bigint, values: readonly bigint[]) {
		const o: Owner = await owner(m, seed, [deposit])
		const session: BridgeSession = await sessionOf(m, o)
		const c = client()
		const holder: Account = await account(dev)
		const receipts: BridgeReceipt[] = []
		let note = o.notes[0]!.commitment
		for (const amount of values) {
			await c.preflight({ recipient: holder.address, wallet: dev.wallet })
			const spend = await prepareBridgeSpend(session, { note, amount, portal: m.bridge.portal, recipient: holder.address })
			expect(spend.change.label).toBe(o.notes[0]!.label)
			receipts.push(await c.submit(spend, await sender(m), session))
			note = spend.change.commitment
		}
		for (const r of receipts) await c.waitClaimable(r)
		await holder.deploy()
		await send(dev, holder.address, oneTransaction(await Promise.all(receipts.map((r) => c.claimPayload(session, r)))))
		return { o, session, client: c, holder, label: o.notes[0]!.label }
	}

	/** One sponsored transaction from `holder` holding one `ragequit` per amount, all under `label` to `payee`. */
	async function ragequit(holder: Account, payee: Address, label: bigint, amounts: readonly bigint[]) {
		const hub = AztecAddress.fromStringUnsafe(m.bridge.hub)
		const token = AztecAddress.fromStringUnsafe(m.bridge.token)
		const calls = await Promise.all(
			amounts.map((a) =>
				callPayload(tokenBridgeHubArtifact, hub, "ragequit", [token, EthAddress.fromString(payee), a, new Fr(label)]),
			),
		)
		return send(dev, holder.address, await sponsored(mergeExecutionPayloads(calls)))
	}

	/** Polls `t`'s status until it is `want`; returns every status read, in order, without repeats. */
	async function until(c: BridgeClient, t: ExitTicket, want: ExitStatus): Promise<ExitStatus[]> {
		const seen: ExitStatus[] = []
		for (const end = Date.now() + STATUS_TIMEOUT_MS; ; await new Promise((r) => setTimeout(r, POLL_MS))) {
			const s = await c.exitStatus(t)
			if (seen.at(-1) !== s) seen.push(s)
			if (s === want) return seen
			if (Date.now() > end) throw new Error(`the ticket read ${seen.join(" → ")}, never ${want}`)
		}
	}

	/** The ticket's Outbox witness, read the way `exitStatus` reads it. */
	async function witness(t: ExitTicket) {
		const io = clientIo(m, memoryStore().store)
		const deployment = await verifyDeployment(io.reader, io.node, namedDeployment(m))
		const reads = exitReads({ deployment, reader: io.reader, node: io.node, timing: LOCAL_TIMING })
		return reads.witness(t, await reads.pin())
	}

	/**
	 * Drives blocks with Ethereum transfers, each owing the heartbeat two beats, until the Aztec tip
	 * sits in an epoch after `epoch`: the next transaction then lands in a later epoch.
	 */
	async function intoLaterEpoch(epoch: number): Promise<void> {
		const { epochDuration } = await dev.node.getL1Constants()
		const tipEpoch = async () => {
			const tip = await dev.node.getBlockData(await dev.node.getBlockNumber())
			return Math.floor(Number(tip?.header.globalVariables.slotNumber) / Number(epochDuration))
		}
		const l1 = await sender(m)
		for (let i = 0; i < 20; i++) {
			if ((await tipEpoch()) > epoch) return
			const before = await dev.node.getBlockNumber()
			const hash = await l1.sendTransaction({ account: l1.account!, chain: l1.chain, to: l1.account!.address, value: 0n })
			await chain.waitForTransactionReceipt({ hash })
			for (let j = 0; (await dev.node.getBlockNumber()) <= before; j++) {
				if (j === 60) throw new Error("no Aztec block followed an Ethereum transfer within 60 s")
				await new Promise((r) => setTimeout(r, POLL_MS))
			}
		}
		throw new Error(`the Aztec tip stayed in epoch ${epoch} after 20 transfers`)
	}

	const balanceOf = (who: Address) => chain.readContract({ address: m.pool.asset, abi: erc20Abi, functionName: "balanceOf", args: [who] })

	const timed = async <T>(id: string, f: () => Promise<T>): Promise<T> => {
		const t0 = performance.now()
		try {
			return await f()
		} finally {
			timings[id] = Math.round(performance.now() - t0)
		}
	}

	return { m, seed, chain, dev: () => dev, client, claimed, ragequit, until, witness, intoLaterEpoch, balanceOf, timed }
}
