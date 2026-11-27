import { bridgeDataV1, claimSecretHash } from "@pp/bridge-spec"
import { type Hex, keccak256, parseTransaction, toHex } from "viem"
import { describe, expect, it } from "vitest"
import type { BridgeSession } from "../../../src/client/session"
import type { PreparedBridgeSpend } from "../../../src/client/types"
import { account, owner, sender, sessionOf } from "./support/actors"
import { code, submitKit } from "./support/submit-kit"

const k = submitKit("submit")
const { m, seed, chain } = k

describe("submit", () => {
	it("S1 refuses six bad preconditions on real proofs, each after a passing preflight, with zero sends and the notes unspent", async () => {
		const t = await k.bridgeCase("S1", [100n, 100n])
		const a = await t.prepare(0, 70n)
		const other = (await account(k.dev())).address
		await t.client.preflight({ recipient: other, wallet: k.dev().wallet })
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
		const t = await k.bridgeCase("S2", [100n])
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
		const t = await k.bridgeCase("S2b", [100n])
		const mine = await t.prepare(0, 70n)
		await k.landDirectly(await t.prepare(0, 70n, (await account(k.dev())).address))
		expect(await code(t.client.submit(mine, t.l1, t.session))).toBe("CONSUMED_ELSEWHERE")
		expect(t.wire.sends).toEqual([])
		t.done()
	})

	it("S5 the ASP root moves after every check passed and before the node sees the transaction: REVERTED naming the cause, no retry", async () => {
		const t = await k.bridgeCase("S5", [100n])
		const spend = await t.prepare(0, 70n)
		t.wire.hooks.beforeSend = async () => {
			t.wire.hooks.beforeSend = undefined
			await k.moveAspRoot()
		}
		const e = await t.client.submit(spend, t.l1, t.session).catch((x: unknown) => x)
		expect(e).toMatchObject({ code: "REVERTED", stale: "ASP_ROOT_STALE", l1TxHash: keccak256(t.wire.sends[0]!) })
		expect(t.wire.sends).toHaveLength(1)
		expect(await t.unspent()).toContain(t.o.notes[0]!.commitment)
		t.done()
	})
})
