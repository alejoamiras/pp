import { hexToBigInt, parseAbi } from "viem"
import { describe, expect, it } from "vitest"
import { bridgeMessageKey } from "../../../src/client/messages"
import { rollupEndpointsOf } from "../../../src/generation-bindings"
import { advanceChainTime, owner } from "./support/actors"
import { submitKit } from "./support/submit-kit"

const k = submitKit("reprove")
const { m, seed, chain } = k

describe("submit re-proves a stale spend", () => {
	it("S3 another owner registers and 1201 s pass: KEYSTORE_ROOT_STALE, one re-proof, bridged under the same secret hash", async () => {
		const t = await k.bridgeCase("S3", [100n])
		const spend = await t.prepare(0, 70n)
		await (await owner(m, seed, [], { registered: false })).register()
		await advanceChainTime(m, 1201)
		const reproved: string[] = []
		const r = await t.client.submit(spend, t.l1, t.session, { onReprove: (c) => reproved.push(c) })
		expect(reproved).toEqual(["KEYSTORE_ROOT_STALE"])
		const endpoints = { portal: m.bridge.portal, chainId: m.chainId, hub: m.bridge.hub, ...(await rollupEndpointsOf(k.dev().node)) }
		expect(await bridgeMessageKey(endpoints, r, hexToBigInt(spend.secretHash))).toBe(r.messageKey)
		t.done()
	})

	it("S4 an approval moves the ASP root: ASP_ROOT_STALE, one re-proof, bridged", async () => {
		const t = await k.bridgeCase("S4", [100n])
		const spend = await t.prepare(0, 70n)
		await k.moveAspRoot()
		const reproved: string[] = []
		await expect(t.client.submit(spend, t.l1, t.session, { onReprove: (c) => reproved.push(c) })).resolves.toMatchObject({
			amount: 70n,
		})
		expect(reproved).toEqual(["ASP_ROOT_STALE"])
		t.done()
	})

	it("S7 enough deposits evict a held proof's state root: STATE_ROOT_STALE, one re-proof, bridged", async () => {
		const t = await k.bridgeCase("S7", [100n])
		const spend = await t.prepare(0, 70n)
		const VIEWS = parseAbi(["function isKnownRoot(uint256) view returns (bool)"])
		const stateRoot = spend.proof.pubSignals[2]![0]!
		const known = () => chain.readContract({ address: m.pool.poolVault, abi: VIEWS, functionName: "isKnownRoot", args: [stateRoot] })
		await seed.mint(t.o.address, 100n)
		let deposits = 0
		for (; (await known()) && deposits < 100; deposits++) await t.o.deposit(1n)
		console.log(`[reprove] I-5: the held state root left the vault's history after ${deposits} deposits`)
		expect(await known()).toBe(false)
		const reproved: string[] = []
		await expect(t.client.submit(spend, t.l1, t.session, { onReprove: (c) => reproved.push(c) })).resolves.toMatchObject({
			amount: 70n,
		})
		expect(reproved).toEqual(["STATE_ROOT_STALE"])
		t.done()
	})
})
