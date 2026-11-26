import { type Address, type Hex, parseSignature, serializeCompactSignature, signatureToCompactSignature, toHex } from "viem"
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest"
import { deriveKeys } from "../../src/keys.ts"
import { openPoolClient, type PoolClient, type PreparedSpend, spendRevertCode } from "../../src/index.ts"
import { poolConfig, type UpEnv } from "../support/env.ts"
import { circuitsDir } from "../support/paths.ts"
import { type Seeder, seeder } from "../support/seed.ts"

const env = JSON.parse(inject("poolEnv")) as UpEnv
const pool = poolConfig(env)
/** Not the note's owner: the proof binds the processor, not the sender. */
const SUBMITTER = 11
const DATA: Hex = "0xc0ffee"

const open = (address: Address, signature: Hex): Promise<PoolClient> =>
	openPoolClient({ pool, l1Address: address, signature, artifacts: { kind: "dir", path: circuitsDir() } })

const withSignal = (s: PreparedSpend, row: number, v: bigint): PreparedSpend => ({
	...s,
	proof: { ...s.proof, pubSignals: s.proof.pubSignals.map((r, i) => (i === row ? [v] : r)) },
})
const flipNoteByte = (s: PreparedSpend): PreparedSpend => {
	const d = s.noteData[0]!.data
	const i = d.length - 2
	return {
		...s,
		noteData: [
			{ ...s.noteData[0]!, data: `${d.slice(0, i)}${(Number.parseInt(d.slice(i), 16) ^ 1).toString(16).padStart(2, "0")}` as Hex },
		],
	}
}

type User = Awaited<ReturnType<Seeder["user"]>>

describe("pool-client against pp-env up", () => {
	const t0 = performance.now()
	const consoleCalls: unknown[][] = []
	const aspRequests: string[] = []
	let seed: Seeder
	let stubA: Address
	let stubB: Address
	let u13: User
	let u12: User
	let note13: { label: bigint; commitment: bigint }
	let note12: { label: bigint; commitment: bigint }
	let client13: PoolClient
	let first: PreparedSpend

	async function refused(stub: Address, spend: PreparedSpend, errorName: string): Promise<Hex | undefined> {
		const sim = await seed.simulate(stub, spend, SUBMITTER)
		expect(sim).toMatchObject({ ok: false, errorName })
		return sim.ok ? undefined : sim.raw
	}

	beforeAll(async () => {
		for (const m of ["log", "info", "warn", "error", "debug"] as const)
			vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void consoleCalls.push(args))
		const realFetch = globalThis.fetch
		vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
			const url = String(input instanceof Request ? input.url : input)
			if (url.startsWith(env.aspUrl) && !url.includes("/admin/")) aspRequests.push(new URL(url).pathname)
			return realFetch(input, init)
		})
		seed = seeder(env)
		u13 = await seed.user(13)
		u12 = await seed.user(12)
		for (const u of [u13, u12]) await seed.mint(u.address, 1_000n)
		stubA = await seed.deployStub()
		stubB = await seed.deployStub()
	})

	afterAll(() => {
		vi.restoreAllMocks()
		console.log(`[pool-client] integration suite on ${"Bun" in globalThis ? "bun" : "node"}: ${Math.round(performance.now() - t0)} ms`)
	})

	it("1. lists a seeded, approved note from both signature encodings", async () => {
		await u13.register()
		await u12.register()
		note13 = await u13.deposit(100n)
		note12 = await u12.deposit(10n)
		await seed.approveLabel(note13.label)
		await seed.approveLabel(note12.label)
		const compact = serializeCompactSignature(signatureToCompactSignature(parseSignature(u13.signature)))
		for (const signature of [u13.signature, compact]) {
			const notes = await (await open(u13.address, signature)).notes()
			expect(notes).toContainEqual(
				expect.objectContaining({ commitment: note13.commitment, label: note13.label, value: 100n, status: "approved" }),
			)
		}
	})

	it("2. prepares a spend that a fresh client can recover before it is sent, then pays the stub", async () => {
		client13 = await open(u13.address, u13.signature)
		first = await client13.prepareSpend({ note: note13.commitment, amount: 70n, processor: stubA, data: DATA })
		expect(Object.isFrozen(first.proof.pubSignals)).toBe(true)

		const fresh = await open(u13.address, u13.signature)
		await fresh.assertRecoverable(first)
		await expect(fresh.assertRecoverable(flipNoteByte(first))).rejects.toMatchObject({ code: "SPEND_CHECK_FAILED", check: "change" })
		expect(await fresh.nullifierOf(note13.commitment)).toBe(first.proof.pubSignals[0]![0])
		await expect(fresh.nullifierOf(note12.commitment)).rejects.toMatchObject({ code: "NOTE_NOT_FOUND" })

		expect(await seed.submit(stubA, first, SUBMITTER)).toMatchObject({
			nullifier: first.nullifier,
			changeCommitment: first.change.commitment,
			amount: 70n,
			data: DATA,
		})
		expect(await seed.stubState(stubA)).toEqual({ balance: 70n, spends: 1n })
		const notes = await client13.notes()
		expect(notes).toContainEqual(expect.objectContaining({ commitment: note13.commitment, status: "spent" }))
		expect(notes).toContainEqual(
			expect.objectContaining({ commitment: first.change.commitment, value: 30n, label: note13.label, status: "approved" }),
		)
	})

	it("3. the vault refuses a mutated spend, and one sent through another processor", async () => {
		const s = await client13.prepareSpend({ note: first.change.commitment, amount: 10n, processor: stubA, data: DATA })
		await refused(stubA, { ...s, data: "0xc0ffef" }, "PoolVault_ProofContextMismatch")
		await refused(stubA, flipNoteByte(s), "PoolVault_ProofContextMismatch")
		await refused(stubA, withSignal(s, 5, 11n), "PoolVault_InvalidTransactProof")
		await refused(stubB, s, "PoolVault_InvalidProcessor")
		const half = { note: first.change.commitment, amount: 10n, processor: stubA, data: "0xabc" as Hex }
		await expect(client13.prepareSpend(half)).rejects.toThrow("whole bytes")
	})

	it("4. a fresh client recovers the change opening from chain logs alone", async () => {
		const fresh = await open(u13.address, u13.signature)
		const opening = await fresh.changeOpening(first.nullifier)
		expect(opening).toEqual(first.change)
	})

	it("5. reports stale ASP and keystore roots before sending, and maps the reverts", async () => {
		const client12 = await open(u12.address, u12.signature)
		const stale = await client12.prepareSpend({ note: note12.commitment, amount: 4n, processor: stubA, data: DATA })
		const u10 = await seed.user(10)
		await seed.mint(u10.address, 10n)
		await u10.register()
		await seed.approveLabel((await u10.deposit(1n)).label)
		await expect(client12.assertFresh(stale)).rejects.toMatchObject({ code: "ASP_ROOT_STALE" })
		expect(spendRevertCode((await refused(stubA, stale, "PoolVault_InvalidASPRoot"))!)).toBe("ASP_ROOT_STALE")

		const reproved = await client12.prepareSpend({ note: note12.commitment, amount: 4n, processor: stubA, data: DATA })
		await client12.assertFresh(reproved)
		await seed.submit(stubA, reproved, SUBMITTER)

		const later = await client12.prepareSpend({ note: reproved.change.commitment, amount: 2n, processor: stubA, data: DATA })
		await (await seed.user(9)).register()
		await client12.assertFresh(later)
		await seed.advance(1201)
		await expect(client12.assertFresh(later)).rejects.toMatchObject({ code: "KEYSTORE_ROOT_STALE" })
		expect(spendRevertCode((await refused(stubA, later, "PoolVault_UnknownKeystoreRoot"))!)).toBe("KEYSTORE_ROOT_STALE")
	})

	it("6. spends a whole note, leaving a recoverable zero-value change", async () => {
		const upper = `0x${DATA.slice(2).toUpperCase()}` as Hex
		const s = await client13.prepareSpend({ note: first.change.commitment, amount: 30n, processor: stubA, data: upper })
		expect(s.change.value).toBe(0n)
		await (await open(u13.address, u13.signature)).assertRecoverable(s)
		expect(await seed.submit(stubA, s, SUBMITTER)).toMatchObject({ amount: 30n, data: DATA })
		expect(await client13.notes()).toContainEqual(
			expect.objectContaining({ commitment: s.change.commitment, value: 0n, status: "approved" }),
		)
	})

	it("7. logged nothing secret, and never asked the ASP about one label", () => {
		const secrets = [u13, u12].flatMap((u) => {
			const { keystore } = deriveKeys(u.address, u.signature)
			return [
				u.signature,
				parseSignature(u.signature).r,
				keystore.getPrivateNullifyingKey(),
				keystore.getPrivateRevocableKey(),
				keystore.getViewingKeyPair().privateKey,
			]
		})
		// JSON drops an Error's own fields, which are where a leaked secret would sit.
		const logged = JSON.stringify(consoleCalls, (_k, v) =>
			typeof v === "bigint" ? toHex(v) : v instanceof Error ? { message: v.message, stack: v.stack, cause: v.cause } : v,
		).toLowerCase()
		for (const s of secrets) expect(logged).not.toContain(s.slice(2).toLowerCase())
		expect(aspRequests.length).toBeGreaterThan(0)
		expect(aspRequests.filter((p) => p.includes("/labels/"))).toEqual([])
	})
})
