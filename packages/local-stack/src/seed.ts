import { anvilKey, type PoolEnv } from "@pp/pp-env"
import type { Address } from "viem"
import { privateKeyToAccount } from "viem/accounts"

/** The demo's pool user: registered, holding two approved notes. */
export const SEED_USER_INDEX = 13
/** The demo's separate Ethereum sender: a bridge from the note owner's own address is refused. */
export const DEMO_SENDER_INDEX = 12
/** The demo sender's address, the one value of it a page build may carry. */
export const DEMO_SENDER_ADDRESS: Address = privateKeyToAccount(anvilKey(DEMO_SENDER_INDEX)).address
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
