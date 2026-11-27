import { Fr } from "@aztec-labs/foundation/curves/bn254"
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { type Address, type Hex, toHex } from "viem"
import { describe, expect, expectTypeOf, it, vi } from "vitest"
import {
	ASSET,
	aztecWallet,
	bridgeSpend,
	FakeChain,
	fakePool,
	HUB,
	manifest,
	memoryStore,
	OWNER,
	openSession,
	PORTAL,
	randomRecipient,
	VAULT,
} from "../test/client-fakes"
import { type BridgeClient, bridgeClientOver, type ClientIo, createBridgeClient } from "./bridge-client"
import type { WaitClaimableOptions } from "./claim"
import type { prepareBridgeSpend } from "./prepare"
import type { BridgeSession } from "./session"
import type { SubmitOptions } from "./submit"
import type { BridgeReceipt } from "./types"

const IMPLEMENTATION: Address = "0x00000000000000000000000000000000000000b2"
const INBOX: Address = "0x00000000000000000000000000000000000000b3"
const OUTBOX: Address = "0x00000000000000000000000000000000000000b4"
const OTHER: Address = "0x00000000000000000000000000000000000000b5"

/** The reads `assertGenerationBindings` makes, answering as a generation bound to `manifest()` would. */
const BINDINGS: Record<string, unknown> = {
	IMPLEMENTATION,
	L2_HUB: HUB,
	owner: OWNER,
	INBOX,
	OUTBOX,
	ROLLUP_VERSION: 1n,
	FACTORY: manifest().bridge?.factory,
	POOL: VAULT,
	LIFETIME_CAP: 10n ** 24n,
	portalOf: PORTAL,
	underlying: ASSET,
}

function setup(o: { chainId?: number; l1ChainId?: number; rollupVersion?: number; reads?: Record<string, unknown> } = {}) {
	const chain = new FakeChain()
	const answers = { ...BINDINGS, ...o.reads }
	const readContract = vi.fn(async (q: { functionName: string }) =>
		q.functionName in answers ? answers[q.functionName] : chain.reader.readContract(q as never),
	)
	const reader = { ...chain.reader, getChainId: vi.fn(async () => o.chainId ?? 31337), readContract }
	const node = {
		getNodeInfo: vi.fn(async () => ({
			l1ChainId: o.l1ChainId ?? 31337,
			rollupVersion: o.rollupVersion ?? 1,
			l1ContractAddresses: { inboxAddress: INBOX, outboxAddress: OUTBOX },
		})),
		getPublicStorageAt: vi.fn(async () => new Fr(10n ** 18n)),
		getL1ToL2MessageIndex: vi.fn(async () => undefined),
		getBlockData: vi.fn(async () => undefined),
		getL1ToL2MessageMembershipWitness: vi.fn(async () => undefined),
		findLeavesIndexes: vi.fn(async () => []),
	}
	const { store } = memoryStore()
	const client = bridgeClientOver(manifest(), { reader, node, store } as unknown as ClientIo)
	const bindingReads = () => readContract.mock.calls.filter(([q]) => q.functionName in BINDINGS).length
	return { chain, client, reader, node, readContract, bindingReads }
}

describe("createBridgeClient", () => {
	it("checks the chain and the bindings once, then every method acts on that deployment", async () => {
		const t = setup()
		const pool = fakePool()
		const session = await openSession(pool)
		expect(await t.client.records(session)).toEqual([])
		const reads = t.bindingReads()
		expect(reads).toBeGreaterThan(0)
		expect(await t.client.recover(session, await randomRecipient())).toEqual([])
		expect(t.bindingReads()).toBe(reads)
		expect(t.reader.getChainId).toHaveBeenCalledOnce()
		expect(pool.notes).toHaveBeenCalledTimes(2)
	})

	it.each<[string, Parameters<typeof setup>[0], string]>([
		["an L1 RPC on another chain", { chainId: 1 }, "CHAIN_MISMATCH"],
		["a node following a rollup on another chain", { l1ChainId: 1 }, "CHAIN_MISMATCH"],
		["a node on another rollup version", { rollupVersion: 2 }, "DEPLOYMENT_MISMATCH"],
		["a portal bound to another hub", { reads: { L2_HUB: toHex(9n, { size: 32 }) } }, "DEPLOYMENT_MISMATCH"],
		["a portal bound to another vault", { reads: { POOL: OTHER } }, "DEPLOYMENT_MISMATCH"],
		["a portal the factory does not hold for the asset", { reads: { portalOf: OTHER } }, "DEPLOYMENT_MISMATCH"],
	])("refuses %s before acting", async (_, o, code) => {
		const t = setup(o)
		const pool = fakePool()
		await expect(t.client.records(await openSession(pool))).rejects.toMatchObject({ code })
		expect(pool.notes).not.toHaveBeenCalled()
	})

	it("checks again after a check that failed to read", async () => {
		const t = setup()
		t.reader.getChainId.mockRejectedValueOnce(new Error("socket hang up"))
		const session = await openSession()
		await expect(t.client.records(session)).rejects.toMatchObject({ code: "RPC_FAILED" })
		expect(await t.client.records(session)).toEqual([])
	})

	it("takes the spend before its first await, as submit alone does", async () => {
		const t = setup()
		const session = await openSession()
		const recipient = await randomRecipient()
		const wallet = {
			...aztecWallet([recipient]),
			simulateTx: vi.fn(async () => ({})),
		}
		await t.client.preflight({ recipient, wallet: wallet as never })
		const spend = await bridgeSpend(recipient)
		const sent = t.client.submit(spend, t.chain.wallet(), session)
		const mutable = spend as unknown as { secretHash: Hex; proof: { pubSignals: bigint[][] } }
		mutable.secretHash = toHex(1n, { size: 32 })
		mutable.proof.pubSignals[5] = [1n]
		expect(await sent).toMatchObject({ amount: 70n })
		expect(t.chain.writeContract.mock.calls[0]?.[0].args[2]).not.toBe(mutable.secretHash)
	})

	it("refuses a manifest without a bridge when it is built", () => {
		const { bridge: _, ...noBridge } = manifest()
		expect(() => createBridgeClient({ manifest: noBridge, journal: memoryStore().store })).toThrow(
			expect.objectContaining({ code: "DEPLOYMENT_MISMATCH" }),
		)
	})

	it("offers no fee or payment option: every L2 transaction pays through the SponsoredFPC", () => {
		expectTypeOf<keyof Parameters<typeof createBridgeClient>[0]>().toEqualTypeOf<"manifest" | "journal">()
		expectTypeOf<keyof Parameters<typeof prepareBridgeSpend>[1]>().toEqualTypeOf<"note" | "amount" | "portal" | "recipient">()
		expectTypeOf<keyof Parameters<BridgeClient["preflight"]>[0]>().toEqualTypeOf<"recipient" | "wallet">()
		expectTypeOf<keyof SubmitOptions>().toEqualTypeOf<"onReprove" | "acceptUncertain">()
		expectTypeOf<keyof WaitClaimableOptions>().toEqualTypeOf<"forceBlock" | "signal">()
		expectTypeOf<Parameters<BridgeClient["claimPayload"]>>().toEqualTypeOf<[BridgeSession, BridgeReceipt]>()
		expectTypeOf<Parameters<BridgeClient["recover"]>>().toEqualTypeOf<[BridgeSession, AztecAddress]>()
		expectTypeOf<Parameters<BridgeClient["records"]>>().toEqualTypeOf<[BridgeSession]>()
	})
})
