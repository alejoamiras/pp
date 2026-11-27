import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { bridgeDataV1, claimSecretHash } from "@pp/bridge-spec"
import { type Hex, hexToBigInt, keccak256, parseAbi, parseTransaction, toHex } from "viem"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PROCESSOR_PORTAL_ABI } from "../../../src/factory-abi"
import { rollupEndpointsOf } from "../../../src/generation-bindings"
import { type BridgeClient, createBridgeClient } from "../../../src/client/bridge-client"
import { bridgeMessageKey } from "../../../src/client/messages"
import { prepareBridgeSpend } from "../../../src/client/prepare"
import type { BridgeSession } from "../../../src/client/session"
import type { PreparedBridgeSpend } from "../../../src/client/types"
import { memoryStore } from "../../../src/test/client-fakes"
import { account, advanceChainTime, type Device, device, type Owner, owner, seedOf, sender, sessionOf } from "./support/actors"
import { attached, l1Client } from "./support/stack"
import { recordingTransport } from "./support/transport"

const m = attached()
const seed = seedOf(m)
const chain = l1Client(m)
const timings: Record<string, number> = {}
let dev: Device

beforeAll(async () => {
	dev = await device(m, "submit")
})

afterAll(async () => {
	await dev?.stop()
	console.log(`[submit] timings ms: ${JSON.stringify(timings)}`)
})

const code = (p: Promise<unknown>) =>
	p.then(
		() => "resolved",
		(e: { code?: string; check?: string }) => (e.check ? `${e.code}:${e.check}` : e.code),
	)

/** One owner with notes, a client that has preflighted a recipient, and a sender over a recording transport. */
async function bridgeCase(name: string, values: readonly bigint[]) {
	const t0 = performance.now()
	const o: Owner = await owner(m, seed, values)
	const session: BridgeSession = await sessionOf(m, o)
	const client: BridgeClient = createBridgeClient({ manifest: m, journal: memoryStore().store })
	const recipient = (await account(dev)).address
	await client.preflight({ recipient, wallet: dev.wallet })
	const wire = recordingTransport(m.l1Rpc)
	const l1 = await sender(m, wire.transport)
	const prepare = (i: number, amount: bigint, to = recipient) =>
		prepareBridgeSpend(session, { note: o.notes[i]!.commitment, amount, portal: m.bridge.portal, recipient: to })
	const unspent = async () => (await session.pool.notes()).filter((n) => n.status === "approved").map((n) => n.commitment)
	const done = () => (timings[name] = Math.round(performance.now() - t0))
	return { o, session, client, recipient, wire, l1, prepare, unspent, done }
}

/** Sends `s` to the portal from a sender of its own, outside the client. */
async function landDirectly(s: PreparedBridgeSpend): Promise<Hex> {
	const other = await sender(m)
	const hash = await other.writeContract({
		address: m.bridge.portal,
		abi: PROCESSOR_PORTAL_ABI,
		functionName: "bridgeFromPool",
		args: [s.proof, s.noteData, s.secretHash],
		account: other.account!,
		chain: other.chain,
	})
	expect((await chain.waitForTransactionReceipt({ hash })).status).toBe("success")
	return hash
}

const ASP_ROOT = parseAbi(["function latestASPRoot() view returns (uint256)"])
const aspRoot = () => chain.readContract({ address: m.pool.aspRegistry, abi: ASP_ROOT, functionName: "latestASPRoot" })

/** Approves a label nobody holds and waits until the registry's root moved: every held proof's ASP root dies. */
async function moveAspRoot(): Promise<void> {
	const before = await aspRoot()
	await seed.approveLabel(BigInt(Fr.random().toString()))
	for (let i = 0; (await aspRoot()) === before; i++) {
		if (i === 100) throw new Error("the ASP root did not move")
		await new Promise((r) => setTimeout(r, 100))
	}
}

describe("submit", () => {
	it("S1 refuses six bad preconditions on real proofs, each after a passing preflight, with zero sends and the notes unspent", async () => {
		const t = await bridgeCase("S1", [100n, 100n])
		const a = await t.prepare(0, 70n)
		const other = (await account(dev)).address
		await t.client.preflight({ recipient: other, wallet: dev.wallet })
		const salt = a.claimSalt + 1n
		const secretHash = toHex(await claimSecretHash(salt, t.recipient), { size: 32 })
		const proved = await t.session.pool.prepareSpend({
			note: t.o.notes[0]!.commitment,
			amount: 70n,
			processor: m.bridge.portal,
			data: bridgeDataV1(secretHash),
		})
		const noncanonical = { ...proved, claimSalt: salt, secretHash, recipient: t.recipient }
		const b = t.o.notes[1]!.commitment
		const elsewhere = { ...a, spentCommitment: b, nullifier: await t.session.pool.nullifierOf(b) }
		const dave = await sessionOf(m, await owner(m, seed, []))
		const forged = Object.create(Object.getPrototypeOf(t.session)) as BridgeSession
		const [note] = a.noteData
		const flipped = {
			...a,
			noteData: [{ ...note!, data: `${note!.data.slice(0, -2)}${note!.data.endsWith("00") ? "01" : "00"}` as Hex }],
		}

		const cases: [string, PreparedBridgeSpend, BridgeSession, string][] = [
			["wrong recipient", { ...a, recipient: other }, t.session, "SPEND_MISMATCH:secretHash"],
			["non-canonical salt", noncanonical, t.session, "SPEND_MISMATCH:salt"],
			["metadata naming another note", elsewhere, t.session, "SPEND_MISMATCH:nullifier"],
			["another owner's session", a, dave, "NOTE_NOT_FOUND"],
			["a hand-built session", a, forged, "FORGED_SESSION"],
			["flipped change data", flipped, t.session, "SPEND_MISMATCH:change"],
		]
		const before = await t.unspent()
		for (const [name, spend, session, expected] of cases)
			expect([name, await code(t.client.submit(spend, t.l1, session))]).toEqual([name, expected])
		expect(t.wire.sends).toEqual([])
		expect(await t.unspent()).toEqual(before)
		t.done()
	})

	it("S2 a copy of the user's transaction lands in an earlier block: the user's reverts and submit returns the copy's receipt", async () => {
		const t = await bridgeCase("S2", [100n])
		const spend = await t.prepare(0, 70n)
		const copier = await sender(m)
		let copy: Hex | undefined
		t.wire.hooks.beforeSend = async (raw) => {
			t.wire.hooks.beforeSend = undefined
			const tx = parseTransaction(raw)
			copy = await copier.sendTransaction({ to: tx.to!, data: tx.data!, gas: tx.gas, account: copier.account!, chain: copier.chain })
			await chain.waitForTransactionReceipt({ hash: copy })
		}
		const r = await t.client.submit(spend, t.l1, t.session)
		expect(r.l1TxHash).toBe(copy)
		const own = await chain.getTransactionReceipt({ hash: keccak256(t.wire.sends[0]!) })
		const copied = await chain.getTransactionReceipt({ hash: copy! })
		expect(own.status).toBe("reverted")
		expect(own.blockNumber).toBeGreaterThan(copied.blockNumber)
		t.done()
	})

	it("S2b another intent of the same note lands first: CONSUMED_ELSEWHERE", async () => {
		const t = await bridgeCase("S2b", [100n])
		const mine = await t.prepare(0, 70n)
		await landDirectly(await t.prepare(0, 70n, (await account(dev)).address))
		expect(await code(t.client.submit(mine, t.l1, t.session))).toBe("CONSUMED_ELSEWHERE")
		expect(t.wire.sends).toEqual([])
		t.done()
	})

	it("S3 another owner registers and 1201 s pass: KEYSTORE_ROOT_STALE, one re-proof, bridged under the same secret hash", async () => {
		const t = await bridgeCase("S3", [100n])
		const spend = await t.prepare(0, 70n)
		await (await owner(m, seed, [], { registered: false })).register()
		await advanceChainTime(m, 1201)
		const reproved: string[] = []
		const r = await t.client.submit(spend, t.l1, t.session, { onReprove: (c) => reproved.push(c) })
		expect(reproved).toEqual(["KEYSTORE_ROOT_STALE"])
		const endpoints = { portal: m.bridge.portal, chainId: m.chainId, hub: m.bridge.hub, ...(await rollupEndpointsOf(dev.node)) }
		expect(await bridgeMessageKey(endpoints, r, hexToBigInt(spend.secretHash))).toBe(r.messageKey)
		t.done()
	})

	it("S4 an approval moves the ASP root: ASP_ROOT_STALE, one re-proof, bridged", async () => {
		const t = await bridgeCase("S4", [100n])
		const spend = await t.prepare(0, 70n)
		await moveAspRoot()
		const reproved: string[] = []
		await expect(t.client.submit(spend, t.l1, t.session, { onReprove: (c) => reproved.push(c) })).resolves.toMatchObject({
			amount: 70n,
		})
		expect(reproved).toEqual(["ASP_ROOT_STALE"])
		t.done()
	})

	it("S5 the ASP root moves after every check passed and before the node sees the transaction: REVERTED naming the cause, no retry", async () => {
		const t = await bridgeCase("S5", [100n])
		const spend = await t.prepare(0, 70n)
		t.wire.hooks.beforeSend = async () => {
			t.wire.hooks.beforeSend = undefined
			await moveAspRoot()
		}
		const e = await t.client.submit(spend, t.l1, t.session).catch((x: unknown) => x)
		expect(e).toMatchObject({ code: "REVERTED", stale: "ASP_ROOT_STALE", l1TxHash: keccak256(t.wire.sends[0]!) })
		expect(t.wire.sends).toHaveLength(1)
		expect(await t.unspent()).toContain(t.o.notes[0]!.commitment)
		t.done()
	})

	it("S7 enough deposits evict a held proof's state root: STATE_ROOT_STALE, one re-proof, bridged", async () => {
		const t = await bridgeCase("S7", [100n])
		const spend = await t.prepare(0, 70n)
		const VIEWS = parseAbi(["function isKnownRoot(uint256) view returns (bool)"])
		const stateRoot = spend.proof.pubSignals[2]![0]!
		const known = () => chain.readContract({ address: m.pool.poolVault, abi: VIEWS, functionName: "isKnownRoot", args: [stateRoot] })
		await seed.mint(t.o.address, 100n)
		let deposits = 0
		for (; (await known()) && deposits < 100; deposits++) await t.o.deposit(1n)
		console.log(`[submit] I-5: the held state root left the vault's history after ${deposits} deposits`)
		expect(await known()).toBe(false)
		const reproved: string[] = []
		await expect(t.client.submit(spend, t.l1, t.session, { onReprove: (c) => reproved.push(c) })).resolves.toMatchObject({
			amount: 70n,
		})
		expect(reproved).toEqual(["STATE_ROOT_STALE"])
		t.done()
	})
})
