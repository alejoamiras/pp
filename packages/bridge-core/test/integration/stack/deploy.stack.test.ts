import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { openPoolClient } from "@pp/pool-client"
import { anvilAccount, circuitsDir, derivationSignature } from "@pp/pool-client/testing"
import { type Address, toHex } from "viem"
import { describe, expect, it } from "vitest"
import {
	BindingMismatchError,
	deployBridgeGeneration,
	type ExpectedBindings,
	entriesPaused,
	openBridgeEntries,
	registryViews,
	type UnopenedBridge,
} from "../../../scripts/deploy"
import { anvilKey } from "../../../scripts/sandbox/constants"
import { poolConfigOf } from "../../../src/client/session"
import { PORTAL_FACTORY_ABI, PROCESSOR_PORTAL_ABI } from "../../../src/factory-abi"
import { assertGenerationBindings } from "../../../src/generation-bindings"
import { attached, l1Client, scratch } from "./support/stack"

const ZERO_WORD = toHex(0n, { size: 32 })
const OTHER_POOL: Address = "0x000000000000000000000000000000000000dead"

const m = attached()
const l1 = l1Client(m)
const generation = (deployerIndex: number, dataDir: string) => ({
	l1Rpc: m.l1Rpc,
	aztecNode: m.aztecNode,
	chainId: m.chainId,
	pool: { poolVault: m.pool.poolVault, asset: m.pool.asset },
	deployerKey: anvilKey(deployerIndex),
	lifetimeCap: 10n ** 30n,
	dataDir,
})

/** The stack generation's own bindings, read from the chain; the rollup and pool are `base`'s, shared by both. */
async function stackExpectations(base: ExpectedBindings): Promise<ExpectedBindings> {
	const factory = { address: m.bridge.factory, abi: PORTAL_FACTORY_ABI } as const
	const implementation = await l1.readContract({ ...factory, functionName: "IMPLEMENTATION" })
	return {
		...base,
		factory: m.bridge.factory,
		implementation,
		hub: m.bridge.hub,
		guardian: await l1.readContract({ ...factory, functionName: "owner" }),
		lifetimeCap: await l1.readContract({ address: implementation, abi: PROCESSOR_PORTAL_ABI, functionName: "LIFETIME_CAP" }),
		portals: [{ token: m.pool.asset, portal: m.bridge.portal }],
	}
}

describe("the stack's bridge deploy", () => {
	it("D0 the attached stack has an open bridge, no registry, and index 13 holds two approved notes of 100", async () => {
		expect(m.bridge.registry).toBe(ZERO_WORD)
		expect(await l1.readContract({ address: m.bridge.factory, abi: PORTAL_FACTORY_ABI, functionName: "entriesPaused" })).toBe(false)
		const pool = await openPoolClient({
			pool: poolConfigOf(m),
			l1Address: anvilAccount(13).address,
			signature: await derivationSignature(13),
			artifacts: { kind: "dir", path: circuitsDir() },
		})
		const approved = (await pool.notes()).filter((n) => n.status === "approved" && n.value === 100n)
		expect(approved).toHaveLength(2)
	})

	it("D1a a second generation, built on the stack's beats, refuses to open on a wrong pool or another generation's bindings, and stays paused", async () => {
		const dir = scratch("d1a")
		let u: UnopenedBridge | undefined
		try {
			u = await deployBridgeGeneration(generation(11, dir.path))
			await expect(openBridgeEntries(u, { ...u.expected, pool: OTHER_POOL })).rejects.toBeInstanceOf(BindingMismatchError)

			const changing = { ...u.expected, pool: OTHER_POOL }
			const opening = openBridgeEntries(u, changing)
			changing.pool = u.expected.pool
			await expect(opening).rejects.toBeInstanceOf(BindingMismatchError)

			const stacks = await stackExpectations(u.expected)
			await expect(assertGenerationBindings(l1 as never, stacks, "stack")).resolves.toBeUndefined()
			await expect(openBridgeEntries(u, stacks)).rejects.toThrow(/another generation/)
			expect(await entriesPaused(u)).toBe(true)
		} finally {
			await u?.stop()
			dir.remove()
		}
		await expect(u?.stop()).resolves.toBeUndefined()
	})

	it("D1b a generation with registry inputs deploys a registry whose poster and intake are those inputs", async () => {
		const [poster, birthIntake] = (await Promise.all([AztecAddress.random(), AztecAddress.random()])).map(
			(a) => a.toString().toLowerCase() as `0x${string}`,
		) as [`0x${string}`, `0x${string}`]
		const dir = scratch("d1b")
		let u: UnopenedBridge | undefined
		try {
			u = await deployBridgeGeneration({ ...generation(10, dir.path), registry: { poster, birthIntake } })
			expect(u.block.registry).not.toBe(ZERO_WORD)
			const views = await registryViews(u)
			expect(views).toMatchObject({ poster, birthIntake })
			expect(views.admin).not.toBe(ZERO_WORD)
		} finally {
			await u?.stop()
			dir.remove()
		}
	})
})
