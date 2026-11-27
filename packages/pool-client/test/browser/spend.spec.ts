import { expect, test } from "@playwright/test"
import type { Address, Hex } from "viem"
import type { PoolNoteView, PreparedSpend } from "../../src/types.ts"
import { poolConfig, type RunningEnv, startEnv } from "../support/env.ts"
import { type Seeder, seeder } from "../support/seed.ts"
import { decode, encode } from "../support/wire.ts"
import type { SpendInput } from "./page/main.ts"
import { fenceEachTest, openProbe, probe } from "./probe.ts"

const SUBMITTER = 11
const DATA: Hex = "0xc0ffee"

let running: RunningEnv | undefined
let seed: Seeder
let stub: Address
let user: Awaited<ReturnType<Seeder["user"]>>
let note: { label: bigint; commitment: bigint }

fenceEachTest()

test.beforeAll(async () => {
	test.setTimeout(300_000)
	running = await startEnv()
	seed = seeder(running.env)
	user = await seed.user(13)
	await seed.mint(user.address, 1_000n)
	await user.register()
	note = await user.deposit(100n)
	await seed.approveLabel(note.label)
	stub = await seed.deployStub()
})

test.afterAll(async () => {
	await running?.stop()
})

test("prepares in Chromium a spend that the vault accepts", async ({ page }) => {
	await openProbe(page)
	const input: SpendInput = {
		pool: poolConfig(running!.env),
		address: user.address,
		signature: user.signature,
		note: note.commitment,
		amount: 70n,
		processor: stub,
		data: DATA,
	}
	const out = decode<{ notes: PoolNoteView[]; spend: PreparedSpend; prepareMs: number }>(await probe(page).spend(encode(input)))
	console.log(`[pool-client] prepareSpend in Chromium: ${Math.round(out.prepareMs)} ms`)
	expect(out.notes).toContainEqual(expect.objectContaining({ commitment: note.commitment, value: 100n, status: "approved" }))
	expect(await seed.submit(stub, out.spend, SUBMITTER)).toMatchObject({ nullifier: out.spend.nullifier, amount: 70n, data: DATA })
	expect(await seed.stubState(stub)).toEqual({ balance: 70n, spends: 1n })
})
