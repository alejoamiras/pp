import type { PoolEnv } from "@pp/pp-env"
import type { Address } from "viem"
import { DEMO_SENDER_ADDRESS, SEED_USER_INDEX } from "./accounts.ts"

export const SEED_NOTE_VALUE = 100n
const SEED_NOTES = 2

export type Seeded = { user: Address; sender: Address; labels: readonly bigint[] }

/** Registers index 13's keystore, deposits two notes and approves both labels through the mock ASP. */
export async function seedPool(pool: PoolEnv): Promise<Seeded> {
	const user = await pool.createUser({ accountIndex: SEED_USER_INDEX })
	await pool.mint(user.address, SEED_NOTE_VALUE * BigInt(SEED_NOTES))
	await user.registerKeystore()
	const labels: bigint[] = []
	for (let i = 0; i < SEED_NOTES; i++) {
		const { label } = await user.deposit({ asset: pool.asset, value: SEED_NOTE_VALUE })
		await pool.asp.approveLabel(label)
		labels.push(label)
	}
	return { user: user.address, sender: DEMO_SENDER_ADDRESS, labels }
}
