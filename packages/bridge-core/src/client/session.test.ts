import { openPoolClient, PoolClientError } from "@pp/pool-client"
import { type Hex, toHex } from "viem"
import { describe, expect, it, vi } from "vitest"
import {
	aztecWallet,
	bridgeSpend,
	CLAIM_KEY,
	context,
	DEPLOYMENT,
	FakeChain,
	fakePool,
	manifest,
	memoryStore,
	OWNER,
	openSession,
	randomRecipient,
	SIGNATURE,
} from "../test/client-fakes"
import { BridgeClientError } from "./errors"
import { BridgeSession, openBridgeSession, useSession } from "./session"
import { submit } from "./submit"

vi.mock("@pp/pool-client", async (actual) => ({ ...(await actual<typeof import("@pp/pool-client")>()), openPoolClient: vi.fn() }))

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

	it("rejects with a client error carrying nothing of a throwing option getter", async () => {
		const sentinel = "sentinel-7f3a"
		const a = { manifest: manifest(), l1Address: OWNER, signature: SIGNATURE as Hex, artifacts: {} as never }
		Object.defineProperty(a, "signature", {
			get: () => {
				throw new Error(sentinel)
			},
		})
		let returned: unknown
		expect(() => {
			returned = openBridgeSession(a)
		}).not.toThrow()
		const e = await (returned as Promise<unknown>).catch((x: unknown) => x)
		expect(e).toBeInstanceOf(BridgeClientError)
		expect(JSON.stringify(e) + String(e) + String((e as Error).cause ?? "")).not.toContain(sentinel)
	})

	it("derives its keys and deployment from the options as they were when opening began", async () => {
		const opened = Promise.withResolvers<unknown>()
		vi.mocked(openPoolClient).mockReturnValueOnce(opened.promise as never)
		const a = { manifest: manifest(), l1Address: OWNER, signature: SIGNATURE as Hex, artifacts: {} as never }
		const pending = openBridgeSession(a)
		a.signature = `0x${"33".repeat(65)}`
		a.manifest.bridge = { ...a.manifest.bridge!, hub: toHex(0x0b6n, { size: 32 }) }
		opened.resolve(fakePool())
		const { secrets } = useSession(await pending, DEPLOYMENT.id)
		expect(secrets.claimKey).toEqual(CLAIM_KEY)
		expect(vi.mocked(openPoolClient).mock.calls[0]?.[0]).toMatchObject({ signature: SIGNATURE })
	})
})
