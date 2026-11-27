import vectors from "@pp/bridge-spec/vectors/v1.json" with { type: "json" }
import { type Address, getAddress, toHex } from "viem"
import { describe, expect, it } from "vitest"
import { DEPLOYMENT, HUB, PORTAL } from "../test/client-fakes"
import type { ClientDeployment } from "./deployment"
import { exitPublicPayload } from "./exit-public"
import { sponsoredFpcAddress } from "./payload"

const TOKEN = toHex(7n, { size: 32 })
const D: ClientDeployment = { ...DEPLOYMENT, token: TOKEN, outbox: "0x00000000000000000000000000000000000000b4" }
// Exit contents come from the shared v1 vectors, never from this package's own encoder.
const OUT = vectors.out[0]!

const payeeOf = (word: string): Address => {
	const v = BigInt(word)
	return `0x${v.toString(16).padStart(v < 2n ** 160n ? 40 : 42, "0")}`
}

describe("exitPublicPayload", () => {
	it("calls the hub's exit_public for the deployment's token, paid by the SponsoredFPC", async () => {
		const p = await exitPublicPayload(D, { payee: getAddress(OUT.payee), amount: BigInt(OUT.amount) })
		const call = p.calls.find((x) => x.name === "exit_public")
		expect(call?.to.toString()).toBe(HUB)
		expect(call?.args.map((a) => a.toBigInt())).toEqual([BigInt(TOKEN), BigInt(OUT.payee), BigInt(OUT.amount)])
		expect(p.feePayer?.equals(await sponsoredFpcAddress())).toBe(true)
	})

	const refused = vectors.rejections
		.filter((r) => r.fn === "exitContent")
		.map((r) => [r.name, { payee: payeeOf(r.args.payee!), amount: BigInt(r.args.amount!) }, r.error] as const)
	it.each([...refused, ["the portal as payee", { payee: PORTAL, amount: 1n }, "PayeeIsPortal"] as const])(
		"refuses %s before building",
		async (_, a, source) => {
			await expect(exitPublicPayload(D, a)).rejects.toMatchObject({ code: "SPEND_MISMATCH", source })
		},
	)
})
