import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { ProtocolContractAddress } from "@aztec-labs/protocol-contracts"
import { deriveStorageSlotInMap } from "@aztec-labs/stdlib/hash"
import type { ExecutionPayload } from "@aztec-labs/stdlib/tx"
import { describe, expect, it, vi } from "vitest"
import { DEPLOYMENT, offCurveAddress, randomRecipient } from "../test/client-fakes"
import { sponsoredFpcAddress } from "./payload"
import { Preflights, preflight } from "./preflight"

async function setup(o: { listed?: boolean; fpc?: boolean; simulates?: boolean } = {}) {
	const recipient = await randomRecipient()
	const wallet = {
		getAccounts: vi.fn(async () => (o.listed === false ? [] : [{ alias: "", item: recipient }])),
		simulateTx: vi.fn(async (_p: ExecutionPayload, _o: { from: unknown }) => {
			if (o.simulates === false) throw new Error("cannot deploy")
			return {} as never
		}),
	}
	// The Fee Juice balance slot the node is asked for; an FPC that is absent holds nothing.
	const node = { getPublicStorageAt: vi.fn(async () => new Fr(o.fpc === false ? 0n : 10n ** 18n)) }
	const preflights = new Preflights()
	const ctx = { deploymentId: DEPLOYMENT.id, node, preflights }
	const code = (r = recipient) =>
		preflight(ctx, { recipient: r, wallet }).then(
			() => "ok",
			(e: { code: string }) => e.code,
		)
	return { recipient, wallet, node, preflights, code }
}

describe("preflight", () => {
	it("records the recipient once an empty transaction from it, paid by the SponsoredFPC, simulates", async () => {
		const t = await setup()
		expect(await t.code()).toBe("ok")
		const fpc = await sponsoredFpcAddress()
		const slot = await deriveStorageSlotInMap(new Fr(1), fpc)
		expect(t.node.getPublicStorageAt).toHaveBeenCalledWith("latest", ProtocolContractAddress.FeeJuice, slot)
		const [payload, opts] = t.wallet.simulateTx.mock.calls[0]!
		expect(payload.feePayer?.equals(fpc)).toBe(true)
		expect(opts.from).toEqual(t.recipient)
		expect(() => t.preflights.require(DEPLOYMENT.id, t.recipient)).not.toThrow()
	})

	it.each([
		["an invalid point", {}, "RECIPIENT_INVALID"],
		["an address the wallet lacks", { listed: false }, "RECIPIENT_NOT_IN_WALLET"],
		["a network whose SponsoredFPC holds no Fee Juice", { fpc: false }, "FEE_PATH_FAILED"],
		["an account whose sponsored transaction cannot simulate", { simulates: false }, "FEE_PATH_FAILED"],
	] as const)("refuses %s and records nothing", async (name, o, expected) => {
		const t = await setup(o)
		const r = name === "an invalid point" ? await offCurveAddress() : t.recipient
		expect(await t.code(r)).toBe(expected)
		expect(() => t.preflights.require(DEPLOYMENT.id, r)).toThrow(expect.objectContaining({ code: "PREFLIGHT_REQUIRED" }))
	})
})
