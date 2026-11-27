import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { deriveNuloAccountKeys } from "@nulo-sh/wallet-crypto"
import { aspLeaf, BN254_P, buildLeanImt } from "@pp/bridge-spec"
import { birthId, birthLabel, siloedBirthNullifier } from "@pp/bridge-spec/birth"
import type { RootRecord } from "@pp/label-paths"
import { describe, expect, it } from "vitest"
import { botSecret, localBotAccounts } from "../accounts"
import { type Ports, Poster } from "../loop"
import { line } from "../protocol"
import { SnapshotBook } from "../server"
import { type BirthAnnouncement, type BirthTx, checkBirth } from "./check"
import { type BirthSource, BirthReader } from "./reader"

const token = AztecAddress.fromBigIntUnsafe(0x7001n)
const otherToken = AztecAddress.fromBigIntUnsafe(0x7002n)
// Wide values: a short one would turn up by chance inside the hashes the leak check searches.
const owner = AztecAddress.fromBigIntUnsafe(0x1f2e3d4c5b6a79881726354453627180a9b8c7d6e5f40312233445566778899an)
const PIN = 10
const AT = { number: PIN, hash: "0x01" }

type Birth = { token: AztecAddress; txHash: string; event: BirthAnnouncement; tx: BirthTx }

async function birth(t: AztecAddress, txHash: string, secret: bigint, amount = 1_000n): Promise<Birth> {
	const label = birthLabel({ token: t, owner, amount, birthSecret: secret })
	const tx: BirthTx = {
		success: true,
		block: 5,
		nullifiers: [0x1n, await siloedBirthNullifier({ token: t, owner, birthSecret: secret })],
		debits: [{ birthId: birthId({ label, birthSecret: secret }), owner, amount }],
	}
	return { token: t, txHash, event: { label, secret, owner, amount }, tx }
}

function source(births: Birth[], synced = PIN, hashes: string[] = []) {
	const queried: string[] = []
	const src: BirthSource = {
		syncedBlock: async () => synced,
		blockHash: async () => hashes.shift() ?? AT.hash,
		announcements: async (t, toBlock) => {
			queried.push(t.toString())
			return births.filter((b) => b.token.equals(t) && b.tx.block <= toBlock).map(({ event, txHash }) => ({ event, txHash }))
		},
		tx: async (_, txHash) => births.find((b) => b.txHash === txHash)?.tx as BirthTx,
	}
	return { src, queried }
}

describe("a birth", () => {
	it("is approved only when its own transaction proves the announcement", async () => {
		const b = await birth(token, "0xa1", 0x5ec0n)
		expect(await checkBirth(token, PIN, b.event, b.tx)).toEqual({ ok: true, leaf: aspLeaf(b.event.label) })

		const stranger = AztecAddress.fromBigIntUnsafe(0x0e02n)
		const [debit] = b.tx.debits
		const cases: [string, Partial<BirthAnnouncement>, Partial<BirthTx>][] = [
			["reverted", {}, { success: false }],
			["above_pin", {}, { block: PIN + 1 }],
			["invalid_fields", { secret: BN254_P }, {}],
			["label_mismatch", { label: b.event.label + 1n }, {}],
			["label_mismatch", { amount: 999n }, {}],
			["no_debit", {}, { debits: [] }],
			["no_debit", {}, { debits: [{ ...debit!, owner: stranger }] }],
			["no_debit", {}, { debits: [{ ...debit!, amount: 999n }] }],
			["no_debit", {}, { debits: [{ ...debit!, birthId: debit!.birthId + 1n }] }],
			["no_nullifier", {}, { nullifiers: [0x1n] }],
		]
		for (const [reason, event, tx] of cases) {
			expect(await checkBirth(token, PIN, { ...b.event, ...event }, { ...b.tx, ...tx }), reason).toEqual({ ok: false, reason })
		}
		expect(await checkBirth(otherToken, PIN, b.event, b.tx)).toEqual({ ok: false, reason: "label_mismatch" })
	})

	it("reads only the given tokens, dedupes, logs a refusal once, and refuses to answer while the PXE is behind", async () => {
		const a = await birth(token, "0xa1", 0x5ec0n)
		const twice = { ...a, txHash: "0xa2" }
		const forged = { ...(await birth(token, "0xa3", 0x5ec1n)), tx: { ...a.tx, debits: [] } }
		const elsewhere = await birth(otherToken, "0xb1", 0x5ec2n)
		const logs: string[] = []
		const { src, queried } = source([a, twice, forged, elsewhere])
		const reader = new BirthReader(src, [token], (event, f) => logs.push(`${event} ${f.txHash} ${f.reason}`))

		expect(await reader.leaves(AT)).toEqual([aspLeaf(a.event.label)])
		expect(await reader.leaves(AT)).toEqual([aspLeaf(a.event.label)])
		expect(queried).toEqual([token.toString(), token.toString()])
		expect(logs).toEqual(["birth_refused 0xa3 no_debit"])

		const behind = new BirthReader(source([a], PIN - 1).src, [token], () => {})
		await expect(behind.leaves(AT)).rejects.toThrow("behind the pinned block 10")
	})

	it("refuses a set read across a change of its pinned block", async () => {
		const a = await birth(token, "0xa1", 0x5ec0n)
		const moved = new BirthReader(source([a], PIN, ["0x02"]).src, [token], () => {})
		await expect(moved.leaves(AT)).rejects.toThrow("block 10 changed during the birth scan")
	})

	it("never lets a birth secret, an owner or the intake's keys reach a log, a snapshot or the ready event", async () => {
		const stackRunId = "stack-leak"
		const intakeSecret = botSecret("intake", stackRunId)
		const keys = await deriveNuloAccountKeys(Fr.fromHexString(intakeSecret))
		const good = await birth(token, "0xa1", 0x2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081n)
		const bad = await birth(token, "0xa2", 0x0d1c2b3a49586776859483a2b1c0d9e8f7061524334251607f8e9dacbbcadbe9n)
		bad.event = { ...bad.event, secret: BN254_P + 7n }
		const out: string[] = []
		const reader = new BirthReader(source([good, bad]).src, [token], (event, f) => out.push(line({ event, ...f })))
		let record: RootRecord = { sequence: 0n, poolRoot: 0n, birthRoot: 0n, l1Block: 0n, rootTime: 0n, poolSize: 0n, birthSize: 0n }
		const poolLeaves = [aspLeaf(1n)]
		const ports: Ports = {
			tip: async () => ({ number: PIN, hash: "0x01", time: 1_000n }),
			record: async () => record,
			poster: async () => 0xb07n,
			selectL1: async () => ({ number: 10n, hash: "0x0a", timestamp: 900n }),
			aspRootAt: async () => buildLeanImt(poolLeaves).root,
			aspLeaves: async () => poolLeaves,
			birthLeaves: (tip) => reader.leaves(tip),
			post: async (a) => {
				record = { ...a }
				return { inclusionTime: 1_072n }
			},
			log: (event, fields) => out.push(line({ event, ...fields })),
		}
		const book = new SnapshotBook()
		expect((await new Poster(ports, book, { self: 0xb07n, inclusionMarginSec: 144n }).tick()).post).toBe(true)
		expect(record.birthRoot).toBe(buildLeanImt([aspLeaf(good.event.label)]).root)

		const { poster, birthIntake } = await localBotAccounts(stackRunId)
		out.push(book.body("latest") as string, line({ event: "ready", url: "http://127.0.0.1:1", port: 1, poster, birthIntake }))
		const text = out.join("\n").toLowerCase()
		const secrets = [good.event.secret, bad.event.secret, owner.toBigInt(), BigInt(intakeSecret)]
		for (const k of [keys.secretKey, keys.signingKey]) secrets.push(BigInt(k.toString()))
		for (const s of secrets) {
			for (const form of [s.toString(), s.toString(16), s.toString(16).padStart(64, "0")]) expect(text).not.toContain(form)
		}
		expect(text).toContain("birth_refused")
	})
})
