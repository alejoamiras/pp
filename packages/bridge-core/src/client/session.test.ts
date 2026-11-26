import { PoolClientError } from "@pp/pool-client"
import { toHex } from "viem"
import { describe, expect, it } from "vitest"
import {
	aztecWallet,
	bridgeSpend,
	context,
	DEPLOYMENT,
	FakeChain,
	fakePool,
	manifest,
	memoryStore,
	openSession,
	randomRecipient,
} from "../test/client-fakes"
import { BridgeClientError } from "./errors"
import { BridgeSession, useSession } from "./session"
import { submit } from "./submit"

describe("BridgeSession", () => {
	it("cannot be built or imitated outside openBridgeSession", async () => {
		expect(() => new BridgeSession(Symbol("BridgeSession"), {} as never)).toThrow(BridgeClientError)
		const forged = Object.create(BridgeSession.prototype)
		expect(() => useSession(forged, DEPLOYMENT.id)).toThrow(expect.objectContaining({ code: "FORGED_SESSION" }))
		const real = await openSession()
		expect(() => useSession({ ...real }, DEPLOYMENT.id)).toThrow(expect.objectContaining({ code: "FORGED_SESSION" }))
		const elsewhere = await openSession(fakePool(), manifest(toHex(0x0b6n, { size: 32 })))
		expect(() => useSession(elsewhere, DEPLOYMENT.id)).toThrow(expect.objectContaining({ code: "SESSION_DEPLOYMENT_MISMATCH" }))
	})

	it("is frozen, serialises to {}, and keeps the pool methods it bound at open", async () => {
		const pool = fakePool()
		pool.assertRecoverable.mockRejectedValue(new PoolClientError("SPEND_CHECK_FAILED", "x", { check: "nullifier" }))
		const s = await openSession(pool)
		expect(() => {
			;(s as unknown as { pool: unknown }).pool = fakePool()
		}).toThrow(TypeError)
		expect(() => {
			;(s.pool as { nullifierOf: unknown }).nullifierOf = async () => 0n
		}).toThrow(TypeError)
		expect(JSON.stringify(s)).toBe("{}")

		Object.assign(pool, { nullifierOf: async () => 0n, assertRecoverable: async () => {} })
		expect(await s.pool.nullifierOf(1n)).not.toBe(0n)
		const chain = new FakeChain()
		const ctx = context(chain, memoryStore().store)
		const recipient = await randomRecipient()
		ctx.preflights.record(DEPLOYMENT.id, recipient, aztecWallet([recipient]))
		await expect(submit(ctx, await bridgeSpend(recipient), chain.wallet(), s)).rejects.toMatchObject({
			code: "SPEND_MISMATCH",
			check: "nullifier",
		})
		expect(chain.writeContract).not.toHaveBeenCalled()
	})
})
