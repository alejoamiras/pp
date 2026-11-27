import { bridgeDataV1 } from "@pp/bridge-spec"
import type { SpendRequest } from "@pp/pool-client"
import { describe, expect, it, vi } from "vitest"
import {
	ASSET,
	bridgeSpend,
	CLAIM_KEY,
	fakePool,
	manifest,
	offCurveAddress,
	OWNER,
	openSession,
	PORTAL,
	randomRecipient,
	SPENT_COMMITMENT,
} from "../test/client-fakes"
import { assertBridgeSpend } from "./checks"
import { prepareBridgeSpend } from "./prepare"

/** A pool whose prepareSpend echoes the request into an otherwise canonical spend, as pool-client does. */
async function echoingPool() {
	const base = await bridgeSpend(await randomRecipient())
	return {
		...fakePool(),
		prepareSpend: vi.fn(async (r: SpendRequest) => ({
			...base,
			spentCommitment: r.note,
			amount: r.amount,
			processor: r.processor,
			data: r.data,
		})),
	}
}

describe("prepareBridgeSpend", () => {
	it("derives the salt, secret hash and data inside the session, so the spend passes submit's checks", async () => {
		const pool = await echoingPool()
		const s = await openSession(pool)
		const recipient = await randomRecipient()
		const spend = await prepareBridgeSpend(s, { note: SPENT_COMMITMENT, amount: 70n, portal: PORTAL, recipient })
		await expect(assertBridgeSpend(spend, pool, CLAIM_KEY, { portal: PORTAL, asset: ASSET })).resolves.toBeUndefined()
		expect(pool.prepareSpend).toHaveBeenCalledWith({
			note: SPENT_COMMITMENT,
			amount: 70n,
			processor: PORTAL,
			data: bridgeDataV1(spend.secretHash),
		})
		const again = await prepareBridgeSpend(s, { note: SPENT_COMMITMENT, amount: 70n, portal: PORTAL, recipient })
		expect([again.claimSalt, again.secretHash]).toEqual([spend.claimSalt, spend.secretHash])
	})

	it("refuses another portal, an invalid recipient and a forged session before proving", async () => {
		const pool = await echoingPool()
		const s = await openSession(pool, manifest())
		const recipient = await randomRecipient()
		const call = (session: unknown, o: Partial<{ portal: `0x${string}`; recipient: typeof recipient }>) =>
			prepareBridgeSpend(session, { note: SPENT_COMMITMENT, amount: 70n, portal: PORTAL, recipient, ...o }).catch(
				(e: unknown) => (e as { code: string }).code,
			)
		expect(await call(s, { portal: OWNER })).toBe("DEPLOYMENT_MISMATCH")
		expect(await call(s, { recipient: await offCurveAddress() })).toBe("RECIPIENT_INVALID")
		expect(await call({ ...s }, {})).toBe("FORGED_SESSION")
		expect(pool.prepareSpend).not.toHaveBeenCalled()
	})
})
