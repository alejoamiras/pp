import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { statSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { NoteStatus } from "@ppv2/evm-sdk"
import { type Address, erc20Abi, type Hex, parseEventLogs, type PublicClient } from "viem"
import { TRANSACT_ABI } from "../../src/client/abi.ts"
import type { PoolUser, PreparedSpend } from "../../src/client/types.ts"
import { anvilKey, DEPLOYER_INDEX, USER_INDEX } from "../../src/env/harness/anvil.ts"
import { localClients, type PoolEnv, RUNS_DIR, startPoolEnv } from "../../src/env/index.ts"
import { STUB_PROCESSOR_ABI } from "../../src/env/stub.ts"

/** Any funded account may submit: the proof binds the processor, not the sender. */
const SUBMITTER_INDEX = 12
const DATA = "0xc0ffee" as Hex

const timed = async <T>(m: Record<string, number>, key: string, fn: () => Promise<T>): Promise<T> => {
	const t0 = performance.now()
	const out = await fn()
	m[key] = Math.round(performance.now() - t0)
	return out
}

describe.skipIf(!process.env.PP_ENV_INTEGRATION)("a pool spend paid to a stub processor", () => {
	const ms: Record<string, number> = {}
	let env: PoolEnv
	let client: PublicClient
	let user: PoolUser
	let stubA: Address
	let stubB: Address
	let label: bigint
	let p1: PreparedSpend
	let p2: PreparedSpend

	const stubState = async () => {
		const read = async (stub: Address) => ({
			balance: await client.readContract({ address: env.asset, abi: erc20Abi, functionName: "balanceOf", args: [stub] }),
			spends: await client.readContract({ address: stub, abi: STUB_PROCESSOR_ABI, functionName: "spendCount" }),
		})
		return { a: await read(stubA), b: await read(stubB) }
	}
	const rejectsWith = async (submit: () => Promise<unknown>, error: string) => {
		const before = await stubState()
		await expect(submit()).rejects.toThrow(error)
		expect(await stubState()).toEqual(before)
	}
	const spend = (amountOut: bigint, input?: bigint) =>
		user.prepareSpend({ processor: stubA, data: DATA, asset: env.asset, amountOut, input })
	const noteAt = (commitment: bigint) => user.notes().find((n) => n.commitment === commitment)

	beforeAll(async () => {
		env = await timed(ms, "envStart", () => startPoolEnv())
		client = localClients(env.rpcUrl, anvilKey(DEPLOYER_INDEX)).client
		user = await env.createUser({ accountIndex: USER_INDEX })
		await env.mint(user.address, 1_000n)
		await user.registerKeystore()
		stubA = await env.deployStub()
		stubB = await env.deployStub()
	})

	afterAll(async () => {
		if (!env) return
		const sizes = Object.fromEntries(
			[
				"deposit/groth16_pkey.zkey",
				"deposit/deposit_js/deposit.wasm",
				"transact_1x1/groth16_pkey.zkey",
				"transact_1x1/transact_1x1_js/transact_1x1.wasm",
			].map((f) => [f, statSync(join(env.clientConfig.circuitsDir, f), { throwIfNoEntry: false })?.size ?? null]),
		)
		const dir = join(RUNS_DIR, env.runId)
		await mkdir(dir, { recursive: true })
		await writeFile(join(dir, "measurements.json"), `${JSON.stringify({ timingsMs: ms, artifactBytes: sizes }, null, "\t")}\n`)
		console.log(`[pp-env] measurements: ${join(dir, "measurements.json")} ${JSON.stringify(ms)}`)
		await env.stop()
	})

	test("1. a deposit whose label the ASP approved is an active note", async () => {
		const deposit = await timed(ms, "depositProveAndSubmit", () => user.deposit({ asset: env.asset, value: 100n }))
		label = deposit.label
		await env.asp.approveLabel(label)
		await user.sync()
		expect(noteAt(deposit.commitment)).toMatchObject({ value: 100n, label, status: NoteStatus.ACTIVE })
	})

	test("2. another processor cannot submit a spend bound to stub A", async () => {
		const s = await timed(ms, "transactProve", () => spend(70n))
		await rejectsWith(() => env.submitViaStub(stubB, s, SUBMITTER_INDEX), "PoolVault_InvalidProcessor")
	})

	test("3. changed processor data breaks the proof's context", async () => {
		const s = await spend(70n)
		const [proof, params, noteData] = s.args
		const tampered = { ...s, args: [proof, { ...params, data: "0xbad0" as Hex }, noteData] as const }
		await rejectsWith(() => env.submitViaStub(stubA, tampered, SUBMITTER_INDEX), "PoolVault_ProofContextMismatch")
	})

	test("4. a proof against a superseded ASP root is refused", async () => {
		const s = await spend(70n)
		await env.asp.approveLabel(0xa5a5n)
		await rejectsWith(() => env.submitViaStub(stubA, s, SUBMITTER_INDEX), "PoolVault_InvalidASPRoot")
	})

	test("5. two spends of one note share its nullifier and differ in change", async () => {
		p1 = await spend(70n)
		p2 = await spend(60n)
		expect(p1.nullifier).toBe(p2.nullifier)
		expect(p1.changeCommitment).not.toBe(p2.changeCommitment)
		expect(p1.args[2]).toHaveLength(1)
	})

	test("6. the stub receives the payout and the change comes back as a note", async () => {
		const hash = await env.submitViaStub(stubA, p1, SUBMITTER_INDEX)
		const [asset, amount, nullifier, changeCommitment] = await client.readContract({
			address: stubA,
			abi: STUB_PROCESSOR_ABI,
			functionName: "lastSpend",
		})
		expect({ asset, amount, nullifier, changeCommitment }).toEqual({
			asset: env.asset,
			amount: 70n,
			nullifier: p1.nullifier,
			changeCommitment: p1.args[0].pubSignals[1]?.[0] ?? -1n,
		})
		expect(await stubState()).toMatchObject({ a: { balance: 70n, spends: 1n } })
		const logs = parseEventLogs({ abi: TRANSACT_ABI, logs: (await client.getTransactionReceipt({ hash })).logs })
		const transacted = logs.filter((l) => l.eventName === "Transacted")
		expect(transacted).toHaveLength(1)
		expect(transacted[0]?.args).toMatchObject({
			outputCommitments: [p1.changeCommitment],
			nullifierHashes: [p1.nullifier],
			asset: env.asset,
			withdrawnValue: 70n,
			caller: stubA,
		})
		expect(logs.filter((l) => l.eventName === "Note")).toHaveLength(1)
		expect(logs.filter((l) => l.eventName === "LeavesInserted")).toHaveLength(1)
		await user.sync()
		expect(noteAt(p1.input)?.status).toBe(NoteStatus.SPENT)
		expect(noteAt(p1.changeCommitment)).toMatchObject({ value: 30n, label, status: NoteStatus.ACTIVE })
	})

	test("7. replaying a mined spend is refused on its commitment", async () => {
		await rejectsWith(() => env.submitViaStub(stubA, p1, SUBMITTER_INDEX), "PoolVault_CommitmentAlreadyUsed")
	})

	test("8. a second spend of the same note is refused on its nullifier", async () => {
		await rejectsWith(() => env.submitViaStub(stubA, p2, SUBMITTER_INDEX), "PoolVault_NullifierAlreadySpent")
	})

	test("9. spending a whole note leaves a zero-value change note", async () => {
		const s = await spend(30n, p1.changeCommitment)
		expect(s.changeValue).toBe(0n)
		await env.submitViaStub(stubA, s, SUBMITTER_INDEX)
		expect(await stubState()).toMatchObject({ a: { balance: 100n, spends: 2n } })
		await user.sync()
		expect(noteAt(p1.changeCommitment)?.status).toBe(NoteStatus.SPENT)
		expect(noteAt(s.changeCommitment)).toMatchObject({ value: 0n, label })
	})

	test("10. a call to an address with no code mines, but is not reported as a spend", async () => {
		const codeless: Address = "0x000000000000000000000000000000000000dead"
		await rejectsWith(() => env.submitViaStub(codeless, p2, SUBMITTER_INDEX), "did not process it")
	})
})
