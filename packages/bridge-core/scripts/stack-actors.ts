/**
 * Actors on a running local stack, for its scripts and its test suite: pool owners, Ethereum senders
 * and Aztec devices. Owners and senders sign from mnemonic indices far above the stack's own (0 for
 * the node's publisher, 12 to 15 for the demo, pp-env and the bridge deployer), funded here and drawn
 * afresh per process, so a re-run on a kept stack never meets a registered owner or a used nonce.
 * Local stack only: funding goes through anvil's own methods.
 */
import { anvilAccount, circuitsDir, type Seeder, seeder } from "@pp/pool-client/testing"
import { createTestClient, createWalletClient, type Hex, http, parseEther, type Transport, type WalletClient } from "viem"
import { foundry } from "viem/chains"
import { openBridgeSession } from "../src/client/session"
import type { requireBlocks } from "../src/stack-manifest"
import { type Account, account as accountOf, type Device } from "./account"
import { freshActorSecret } from "./sandbox/l2"

export { type Account, type Device, device, memoryJournal, send } from "./account"

/** A stack manifest that carries a bridge. */
export type BridgeStack = ReturnType<typeof requireBlocks<"bridge">>

let nextIndex = 1_000 + Math.floor(Math.random() * 1_000_000) * 64

export const chainOf = (m: BridgeStack) => ({ ...foundry, rpcUrls: { default: { http: [m.l1Rpc] } } })

export function seedOf(m: BridgeStack): Seeder {
	const { poolVault, entrypoint, keystore, aspRegistry, deployBlock, asset, aspApiUrl } = m.pool
	return seeder({
		runId: "bridge-stack",
		rpcUrl: m.l1Rpc,
		chainId: m.chainId,
		deployment: { pool: poolVault, entrypoint, keystore, aspRegistry, deployBlock: String(deployBlock) },
		asset,
		aspUrl: aspApiUrl,
	})
}

/** A fresh mnemonic index holding gas money. */
export async function fundedIndex(m: BridgeStack): Promise<number> {
	const index = nextIndex++
	const test = createTestClient({ chain: chainOf(m), transport: http(m.l1Rpc), mode: "anvil" })
	await test.setBalance({ address: anvilAccount(index).address, value: parseEther("10") })
	return index
}

export type Note = { label: bigint; commitment: bigint; value: bigint }
export type Owner = {
	address: Hex
	signature: Hex
	notes: Note[]
	register(): Promise<void>
	/** A further deposit, neither minted for nor approved. */
	deposit(value: bigint): Promise<{ label: bigint; commitment: bigint }>
}

/** A pool user holding one approved note per value; `registered: false` leaves its keystore unregistered and holds no notes. */
export async function owner(m: BridgeStack, seed: Seeder, values: readonly bigint[], o: { registered?: boolean } = {}): Promise<Owner> {
	const user = await seed.user(await fundedIndex(m))
	const notes: Note[] = []
	if (o.registered === false)
		return { address: user.address, signature: user.signature, notes, register: user.register, deposit: user.deposit }
	await seed.mint(
		user.address,
		values.reduce((a, b) => a + b, 0n),
	)
	await user.register()
	for (const value of values) {
		const { label, commitment } = await user.deposit(value)
		await seed.approveLabel(label)
		notes.push({ label, commitment, value })
	}
	return { address: user.address, signature: user.signature, notes, register: user.register, deposit: user.deposit }
}

export const sessionOf = (m: BridgeStack, o: Pick<Owner, "address" | "signature">) =>
	// Resolved per session, not at import: a module that only imports this one needs no pool checkout.
	openBridgeSession({ manifest: m, l1Address: o.address, signature: o.signature, artifacts: { kind: "dir", path: circuitsDir() } })

/** An Ethereum sender that signs locally, over `transport` (plain HTTP by default). */
export async function sender(m: BridgeStack, transport?: Transport): Promise<WalletClient> {
	const account = anvilAccount(await fundedIndex(m))
	return createWalletClient({ account, chain: chainOf(m), transport: transport ?? http(m.l1Rpc) })
}

/** An account registered in `d`'s wallet and not deployed; `secret` (default: a fresh one) re-creates it on another device. */
export const account = (d: Device, secret: Hex = freshActorSecret()): Promise<Account> => accountOf(d, secret)
