import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { changeCommitment, deriveClaimSalt } from "@pp/bridge-spec"
import { toHex } from "viem"
import { describe, expect, it, vi } from "vitest"
import { CLAIM_KEY, DEPLOYMENT, fakePool, NULLIFIER, openSession, PORTAL, ASSET, SPENT_COMMITMENT, HUB } from "../test/client-fakes"
import { claimPayload, waitClaimable } from "./claim"
import { sponsoredFpcAddress } from "./payload"
import type { BridgeReceipt } from "./types"

const OPENING = { commitment: 9n, precommitment: 8n, label: 5n, value: 30n }
const TOKEN = toHex(0x70cn, { size: 32 })
const receipt = (o: Partial<BridgeReceipt> = {}): BridgeReceipt => ({
	l1TxHash: toHex(1n, { size: 32 }),
	portal: PORTAL,
	messageKey: toHex(0x4e55n, { size: 32 }),
	leafIndex: 17n,
	nullifier: NULLIFIER,
	changeCommitment: changeCommitment(OPENING.precommitment, OPENING.label),
	amount: 70n,
	asset: ASSET,
	...o,
})

async function setup() {
	const pool = {
		...fakePool(),
		notes: vi.fn(async () => [
			{ commitment: 1n, label: 5n, value: 1n, asset: ASSET, status: "approved" as const },
			{ commitment: SPENT_COMMITMENT, label: 5n, value: 100n, asset: ASSET, status: "spent" as const },
		]),
		nullifierOf: vi.fn(async (c: bigint) => (c === SPENT_COMMITMENT ? NULLIFIER : 1n)),
		changeOpening: vi.fn(async () => OPENING),
	}
	const deployment = { id: DEPLOYMENT.id, hub: HUB, token: TOKEN }
	return { pool, s: await openSession(pool), deployment }
}

describe("claimPayload", () => {
	it("calls the hub's claim_from_pool with the session-derived salt and the pool's opening, paid by the SponsoredFPC", async () => {
		const t = await setup()
		const p = await claimPayload(t.deployment, t.s, receipt())
		expect(p.feePayer?.equals(await sponsoredFpcAddress())).toBe(true)
		const call = p.calls.find((c) => c.name === "claim_from_pool")!
		expect(call.to.equals(AztecAddress.fromStringUnsafe(HUB))).toBe(true)
		const salt = deriveClaimSalt(CLAIM_KEY, SPENT_COMMITMENT)
		expect(call.args.map((a) => a.toBigInt())).toEqual([BigInt(TOKEN), 70n, NULLIFIER, 8n, 5n, salt, 17n])
	})

	it("refuses a nullifier no owned note has, and an opening that does not commit to the receipt's change", async () => {
		const t = await setup()
		const code = (r: BridgeReceipt) => claimPayload(t.deployment, t.s, r).catch((e: { code: string }) => e.code)
		expect(await code(receipt({ nullifier: 999n }))).toBe("NOTE_NOT_FOUND")
		expect(await code(receipt({ changeCommitment: 1n }))).toBe("OPENING_MISMATCH")
	})
})

describe("waitClaimable", () => {
	it("resolves once the tree passes the message's leaf, and stops when aborted", async () => {
		let size = 0n
		const node = {
			getL1ToL2MessageIndex: vi.fn(async () => 40n),
			getBlockData: vi.fn(async () => ({ header: { state: { l1ToL2MessageTree: { nextAvailableLeafIndex: size } } } })),
		}
		const forceBlock = vi.fn(async () => {
			size += 32n
		})
		await waitClaimable(node, receipt(), { forceBlock })
		expect(size).toBeGreaterThan(40n)

		const stuck = { ...node, getL1ToL2MessageIndex: vi.fn(async () => undefined) }
		const abort = new AbortController()
		const waiting = waitClaimable(stuck, receipt(), { signal: abort.signal })
		abort.abort()
		await expect(waiting).rejects.toMatchObject({ code: "RPC_FAILED" })
	}, 20_000)
})
