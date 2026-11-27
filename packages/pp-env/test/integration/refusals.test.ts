import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { NoteStatus } from "#ppv2/evm-sdk"
import type { Address, Hex } from "viem"
import { createPoolUser } from "../../src/client/pool.ts"
import type { PoolUser } from "../../src/client/types.ts"
import { anvilKey, DEPLOYER_INDEX, USER_INDEX } from "../../src/env/harness/anvil.ts"
import { localClients, type PoolEnv, RUNS_DIR, startPoolEnv } from "../../src/env/index.ts"

const DATA = "0xc0ffee" as Hex
const VALUE = 100n

// PoolUser's spend refusals are @pp/pool-client's error codes, and none of them reaches the chain.
describe.skipIf(!process.env.PP_ENV_INTEGRATION)("spend refusals", () => {
	let env: PoolEnv
	let user: PoolUser
	let stub: Address
	let sent: () => Promise<number>

	const spend = (u: PoolUser, amountOut: bigint) => u.prepareSpend({ processor: stub, data: DATA, asset: env.asset, amountOut })
	const refuses = async (u: PoolUser, amountOut: bigint, expected: Record<string, unknown>) => {
		const before = await sent()
		await expect(spend(u, amountOut)).rejects.toMatchObject(expected)
		expect(await sent()).toBe(before)
	}

	beforeAll(async () => {
		env = await startPoolEnv()
		const { client } = localClients(env.rpcUrl, anvilKey(DEPLOYER_INDEX))
		user = await env.createUser({ accountIndex: USER_INDEX })
		sent = () => client.getTransactionCount({ address: user.address })
		await env.mint(user.address, 1_000n)
		await user.registerKeystore()
		stub = await env.deployStub()
		const { label, commitment } = await user.deposit({ asset: env.asset, value: VALUE })
		await env.asp.approveLabel(label)
		await user.sync()
		expect(user.notes().find((n) => n.commitment === commitment)?.status).toBe(NoteStatus.ACTIVE)
	})

	afterAll(async () => {
		await env?.stop()
	})

	test("an amount above the note is AMOUNT_OUT_OF_RANGE", async () => {
		await refuses(user, VALUE + 1n, { code: "AMOUNT_OUT_OF_RANGE" })
	})

	test("a zero amount is AMOUNT_OUT_OF_RANGE", async () => {
		await refuses(user, 0n, { code: "AMOUNT_OUT_OF_RANGE" })
	})

	test("a proving key with one changed byte is ARTIFACT_MISMATCH, naming the file", async () => {
		const dir = join(RUNS_DIR, env.runId, "tampered-circuits")
		const src = join(env.clientConfig.circuitsDir, "transact_1x1")
		const dst = join(dir, "transact_1x1")
		mkdirSync(join(dst, "transact_1x1_js"), { recursive: true })
		symlinkSync(join(src, "transact_1x1_js/transact_1x1.wasm"), join(dst, "transact_1x1_js/transact_1x1.wasm"))
		copyFileSync(join(src, "groth16_vkey.json"), join(dst, "groth16_vkey.json"))
		const zkey = readFileSync(join(src, "groth16_pkey.zkey"))
		zkey[zkey.length >> 1]! ^= 1
		writeFileSync(join(dst, "groth16_pkey.zkey"), zkey)
		try {
			const { wallet } = localClients(env.rpcUrl, anvilKey(USER_INDEX))
			const tampered = await createPoolUser({ ...env.clientConfig, circuitsDir: dir }, { wallet })
			await tampered.sync()
			await refuses(tampered, 10n, { code: "ARTIFACT_MISMATCH", circuit: "transact_1x1", file: "provingKey" })
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
