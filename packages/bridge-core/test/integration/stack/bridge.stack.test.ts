import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { tokenBridgeHubArtifact } from "../../../src/artifacts"
import { createBridgeClient } from "../../../src/client/bridge-client"
import { callPayload, sponsored, sponsoredFpcAddress } from "../../../src/client/payload"
import { prepareBridgeSpend } from "../../../src/client/prepare"
import type { BridgeSession } from "../../../src/client/session"
import { memoryStore, offCurveAddress } from "../../../src/test/client-fakes"
import {
	type Account,
	account,
	blockFees,
	type Device,
	device,
	feeJuice,
	feeJuiceAt,
	labelBalance,
	type Owner,
	owner,
	seedOf,
	send,
	sender,
	sessionOf,
} from "./support/actors"
import { attached } from "./support/stack"
import { recordingTransport } from "./support/transport"

const m = attached()
const seed = seedOf(m)
const timings: Record<string, number> = {}
let alice: Owner
let session: BridgeSession
let dev: Device
let b1Recipient: Account

beforeAll(async () => {
	alice = await owner(m, seed, [100n, 100n])
	session = await sessionOf(m, alice)
	dev = await device(m, "bridge")
})

afterAll(async () => {
	await dev?.stop()
	console.log(`[bridge] timings ms: ${JSON.stringify(timings)}`)
})

const client = () => createBridgeClient({ manifest: m, journal: memoryStore().store })

describe("bridge", () => {
	it("B1 bridges 70 of 100 to a fresh account, which alone claims it, once, paid by the SponsoredFPC", async () => {
		const c = client()
		b1Recipient = await account(dev)
		const recipient = b1Recipient.address
		await c.preflight({ recipient, wallet: dev.wallet })
		const note = alice.notes[0]!
		const spend = await prepareBridgeSpend(session, { note: note.commitment, amount: 70n, portal: m.bridge.portal, recipient })
		const t0 = performance.now()
		const r = await c.submit(spend, await sender(m), session)
		timings.submit = Math.round(performance.now() - t0)
		expect(r).toMatchObject({ amount: 70n, nullifier: spend.nullifier, changeCommitment: spend.change.commitment })
		await c.waitClaimable(r)
		timings.claimable = Math.round(performance.now() - t0)
		const payload = await c.claimPayload(session, r)

		const stranger = await account(dev)
		await stranger.deploy()
		await expect(send(dev, stranger.address, payload)).rejects.toThrow()
		const { precommitment, label } = spend.change
		const args = [dev.token, 70n, spend.nullifier, precommitment, label + 1n, spend.claimSalt, r.leafIndex].map((a) =>
			typeof a === "bigint" ? new Fr(a) : a,
		)
		const wrongLabel = await sponsored(await callPayload(tokenBridgeHubArtifact, dev.hub, "claim_from_pool", args))
		await expect(b1Recipient.deployWith(wrongLabel)).rejects.toThrow()

		const fpc = await sponsoredFpcAddress()
		expect(await feeJuice(dev, recipient)).toBe(0n)
		const t1 = performance.now()
		// I10: the account's deployment and its claim in one sponsored transaction, else one after the other.
		let receipt = await b1Recipient.deployWith(payload).catch((e: unknown) => {
			timings.i10Failed = 1
			console.log(`[bridge] I10: deploy plus claim in one transaction failed: ${String(e).slice(0, 300)}`)
			return undefined
		})
		if (!receipt) {
			await b1Recipient.deploy()
			receipt = await send(dev, recipient, payload)
		}
		timings.claim = Math.round(performance.now() - t1)
		const block = Number(receipt.blockNumber)
		const fees = await blockFees(dev, block)
		expect(fees).toContain(receipt.transactionFee)
		expect((await feeJuiceAt(dev, fpc, block - 1)) - (await feeJuiceAt(dev, fpc, block))).toBe(fees.reduce((a, b) => a + b, 0n))
		expect(await feeJuice(dev, recipient)).toBe(0n)
		expect(await labelBalance(dev, recipient, label)).toBe(70n)

		await expect(send(dev, recipient, payload)).rejects.toThrow()
		const views = await c.records(session)
		expect(views.find((v) => v.nullifier === spend.nullifier)?.step).toBe("claimed")
		expect((await c.records(session)).find((v) => v.nullifier === spend.nullifier)).toBeUndefined()
	})

	it("B2 a whole-note bridge is found and claimed from the signature alone on a new device (non-interactive handshakes only)", async () => {
		const bob = await owner(m, seed, [100n])
		const first = client()
		const bobSession = await sessionOf(m, bob)
		const phone = await device(m, "bridge-phone")
		const laptop = await device(m, "bridge-laptop")
		try {
			const onPhone = await account(phone)
			await first.preflight({ recipient: onPhone.address, wallet: phone.wallet })
			const note = bob.notes[0]!
			const spend = await prepareBridgeSpend(bobSession, {
				note: note.commitment,
				amount: 100n,
				portal: m.bridge.portal,
				recipient: onPhone.address,
			})
			expect(spend.change.value).toBe(0n)
			await first.submit(spend, await sender(m), bobSession)
			const [view] = (await first.records(bobSession)).filter((v) => v.nullifier === spend.nullifier)

			const again = client()
			const reopened = await sessionOf(m, bob)
			const onLaptop = await account(laptop, onPhone.secret)
			expect(onLaptop.address.equals(onPhone.address)).toBe(true)
			const [found, ...rest] = await again.recover(reopened, onLaptop.address)
			expect(rest).toEqual([])
			expect(found).toMatchObject({ id: view?.id, nullifier: spend.nullifier, amount: 100n })
			await again.waitClaimable(found!)
			await onLaptop.deploy()
			await send(laptop, onLaptop.address, await again.claimPayload(reopened, found!))
			expect(await labelBalance(laptop, onLaptop.address, note.label)).toBe(100n)
			expect(await again.recover(reopened, onLaptop.address)).toEqual([])
		} finally {
			await Promise.allSettled([phone.stop(), laptop.stop()])
		}
	})

	it("B3 preflight refuses an invalid point, a stranger and an account whose wallet cannot pay through the FPC, and submit then sends nothing", async () => {
		const c = client()
		const code = (p: Promise<unknown>) =>
			p.then(
				() => "resolved",
				(e: { code?: string }) => e.code,
			)
		expect(await code(c.preflight({ recipient: await offCurveAddress(), wallet: dev.wallet }))).toBe("RECIPIENT_INVALID")
		expect(await code(c.preflight({ recipient: await AztecAddress.random(), wallet: dev.wallet }))).toBe("RECIPIENT_NOT_IN_WALLET")

		// An account its wallet lists but cannot pay for: the wallet has never registered the SponsoredFPC.
		const bare = await device(m, "bridge-bare", { knowsFpc: false })
		const stuck = await account(bare)
		expect(await code(c.preflight({ recipient: stuck.address, wallet: bare.wallet }))).toBe("FEE_PATH_FAILED")
		await bare.stop()

		const note = alice.notes[1]!
		const spend = await prepareBridgeSpend(session, {
			note: note.commitment,
			amount: 10n,
			portal: m.bridge.portal,
			recipient: stuck.address,
		})
		const wire = recordingTransport(m.l1Rpc)
		expect(await code(c.submit(spend, await sender(m, wire.transport), session))).toBe("PREFLIGHT_REQUIRED")
		expect(wire.sends).toEqual([])
		expect((await session.pool.notes()).find((n) => n.commitment === note.commitment)?.status).toBe("approved")

		await c.preflight({ recipient: b1Recipient.address, wallet: dev.wallet })
	})
})
