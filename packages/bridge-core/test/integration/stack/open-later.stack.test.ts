import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { anvilAccount } from "@pp/pool-client/testing"
import { type Address, createPublicClient, createWalletClient, type Hex, http, toHex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { describe, expect, it } from "vitest"
import {
	BindingMismatchError,
	deployBridgeGeneration,
	type GuardianL1,
	type GuardianWallet,
	type OpenContext,
	OpenRefusedError,
	openBridgeEntries,
	openDeployedEntries,
	pauseEntries,
	registryViews,
	type UnopenedBridge,
} from "../../../scripts/deploy"
import { chainOf, fundedIndex } from "../../../scripts/stack-actors"
import { PORTAL_FACTORY_ABI } from "../../../src/factory-abi"
import { attached, scratch } from "./support/stack"

const m = attached()
const node = createAztecNodeClient(m.aztecNode)
const l1 = createPublicClient({ chain: chainOf(m), transport: http(m.l1Rpc) }) as unknown as GuardianL1
const CAP = 10n ** 30n
const WAITS = { timing: { receiptTimeoutMs: 120_000, pollingIntervalMs: 1_000 }, waits: { stallMs: 120_000, finalityMs: 300_000 } }

async function fundedKey(): Promise<Hex> {
	return toHex(anvilAccount(await fundedIndex(m)).getHdKey().privateKey as Uint8Array)
}

const walletOf = (key: Hex, chainId = m.chainId): GuardianWallet =>
	createWalletClient({
		account: privateKeyToAccount(key),
		chain: { ...chainOf(m), id: chainId },
		transport: http(m.l1Rpc),
	}) as unknown as GuardianWallet

const paused = (factory: Address) => l1.readContract({ address: factory, abi: PORTAL_FACTORY_ABI, functionName: "entriesPaused" })

/** What a later process knows: the deploy's public output and the expectations fixed before it. */
async function laterContext(
	u: UnopenedBridge,
	guardian: Address,
	roles: OpenContext["expected"]["registryRoles"],
): Promise<OpenContext & { l1: GuardianL1 }> {
	const info = await node.getNodeInfo()
	return {
		chainId: m.chainId,
		l1,
		node: node as never,
		factory: u.block.factory,
		portals: [{ asset: m.pool.asset, portal: u.block.portal, l2Token: u.block.token }],
		hub: u.block.hub,
		registry: u.block.registry,
		expected: {
			guardian,
			lifetimeCap: CAP,
			pool: m.pool.poolVault,
			rollup: {
				l1Registry: info.l1ContractAddresses.registryAddress.toString() as Address,
				rollup: info.l1ContractAddresses.rollupAddress.toString() as Address,
				inbox: info.l1ContractAddresses.inboxAddress.toString() as Address,
				outbox: info.l1ContractAddresses.outboxAddress.toString() as Address,
				rollupVersion: BigInt(info.rollupVersion),
			},
			...(roles ? { registryRoles: roles } : {}),
		},
	}
}

describe("opening and pausing from a later process", () => {
	it("OL1 a generation with its own guardian opens only through openDeployedEntries, refuses every wrong expectation with no write, then pauses", async () => {
		const guardianKey = await fundedKey()
		const guardian = privateKeyToAccount(guardianKey).address
		const [poster, birthIntake] = (await Promise.all([AztecAddress.random(), AztecAddress.random()])).map(
			(a) => a.toString().toLowerCase() as Hex,
		) as [Hex, Hex]
		const dir = scratch("ol1")
		let u: UnopenedBridge | undefined
		try {
			u = await deployBridgeGeneration({
				l1Rpc: m.l1Rpc,
				aztecNode: m.aztecNode,
				chainId: m.chainId,
				pool: { poolVault: m.pool.poolVault, asset: m.pool.asset },
				deployerKey: await fundedKey(),
				guardian,
				lifetimeCap: CAP,
				registry: { poster, birthIntake },
				dataDir: dir.path,
			})
			await expect(openBridgeEntries(u, u.expected)).rejects.toThrow(/own guardian/)
			const { admin } = await registryViews(u)
			const ctx = await laterContext(u, guardian, { admin, poster, birthIntake })
			const nonce = () => l1.getTransactionCount({ address: guardian })
			const before = await nonce()

			await expect(
				openDeployedEntries({ ...ctx, expected: { ...ctx.expected, lifetimeCap: CAP - 1n } }, walletOf(guardianKey), WAITS),
			).rejects.toBeInstanceOf(BindingMismatchError)
			const other = await fundedKey()
			await expect(
				openDeployedEntries(
					{ ...ctx, expected: { ...ctx.expected, guardian: privateKeyToAccount(other).address } },
					walletOf(other),
					WAITS,
				),
			).rejects.toBeInstanceOf(BindingMismatchError)
			await expect(
				openDeployedEntries(
					{ ...ctx, expected: { ...ctx.expected, rollup: { ...ctx.expected.rollup, inbox: m.pool.asset } } },
					walletOf(guardianKey),
					WAITS,
				),
			).rejects.toBeInstanceOf(OpenRefusedError)
			await expect(openDeployedEntries(ctx, walletOf(guardianKey, 1), WAITS)).rejects.toBeInstanceOf(OpenRefusedError)
			await expect(
				openDeployedEntries(
					{ ...ctx, expected: { ...ctx.expected, registryRoles: { admin, poster: birthIntake, birthIntake } } },
					walletOf(guardianKey),
					WAITS,
				),
			).rejects.toBeInstanceOf(OpenRefusedError)
			expect(await nonce()).toBe(before)
			expect(await paused(u.block.factory)).toBe(true)

			const signed: number[] = []
			await openDeployedEntries(ctx, walletOf(guardianKey), { ...WAITS, onSigned: (s) => signed.push(s.nonce) })
			expect(signed).toEqual([before])
			expect(await paused(u.block.factory)).toBe(false)

			const r = await pauseEntries({ chainId: m.chainId, l1, factory: u.block.factory }, walletOf(guardianKey), WAITS)
			expect(r).toMatchObject({ nonce: before + 1, wasPaused: false })
			expect(await paused(u.block.factory)).toBe(true)
		} finally {
			try {
				await u?.stop()
			} finally {
				dir.remove()
			}
		}
	})

	it("OL2 the in-process open still refuses a mis-bound second portal, then opens through the shared check", async () => {
		const dir = scratch("ol2")
		const deployerKey = await fundedKey()
		let u: UnopenedBridge | undefined
		try {
			u = await deployBridgeGeneration({
				l1Rpc: m.l1Rpc,
				aztecNode: m.aztecNode,
				chainId: m.chainId,
				pool: { poolVault: m.pool.poolVault, asset: m.pool.asset },
				deployerKey,
				lifetimeCap: CAP,
				dataDir: dir.path,
			})
			const stray: Address = "0x000000000000000000000000000000000000beef"
			await expect(
				openBridgeEntries(u, { ...u.expected, portals: [...u.expected.portals, { token: stray, portal: stray }] }),
			).rejects.toBeInstanceOf(BindingMismatchError)
			expect(await paused(u.block.factory)).toBe(true)
			await openBridgeEntries(u, u.expected)
			expect(await paused(u.block.factory)).toBe(false)
			await pauseEntries({ chainId: m.chainId, l1, factory: u.block.factory }, walletOf(deployerKey), WAITS)
			expect(await paused(u.block.factory)).toBe(true)
		} finally {
			try {
				await u?.stop()
			} finally {
				dir.remove()
			}
		}
	})
})
