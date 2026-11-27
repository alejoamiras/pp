import { type Address, concat, encodeAbiParameters, type Hex, keccak256, numberToHex, type PublicClient } from "viem"
import { describe, expect, it, vi } from "vitest"

const meta = (seed: string): Hex => concat([keccak256(`0x${seed}`), numberToHex(32, { size: 2 })])
const BODY: Hex = "0x60806040526004361061"

vi.mock("./creation", async (actual) => {
	const real = await actual<typeof import("./creation")>()
	return { ...real, CREATION_CODES: { PortalFactory: real.creationCodeHash(concat([BODY, meta("01")])) } }
})

const { checkFactoryCreation } = await import("./verify")

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address
const want = { deployer: a(1), registry: a(2), hub: `0x${"ab".repeat(32)}` as Hex, pool: a(3), lifetimeCap: 10n ** 9n, guardian: a(4) }
const FACTORY = a(5)
const args = (o: typeof want) =>
	encodeAbiParameters(
		[{ type: "address" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "address" }],
		[o.registry, o.hub, o.pool, o.lifetimeCap, o.guardian],
	)
const l1 = (input: Hex, from: Address = want.deployer) =>
	({
		getTransaction: async () => ({ from, to: null, input }),
		getTransactionReceipt: async () => ({ contractAddress: FACTORY }),
	}) as unknown as PublicClient
const check = (client: PublicClient) => checkFactoryCreation(client, `0x${"cd".repeat(32)}`, FACTORY, want)

describe("the factory's creation transaction", () => {
	it("passes with the committed code under other metadata and exactly the expected arguments", async () => {
		await expect(check(l1(concat([BODY, meta("02"), args(want)])))).resolves.toBeUndefined()
	})

	it("names the first field that differs: creator, code, then each argument", async () => {
		await expect(check(l1(concat([BODY, meta("01"), args(want)]), a(9)))).rejects.toThrow(/^factory creator/)
		await expect(check(l1(concat(["0x6080", meta("01"), args(want)])))).rejects.toThrow(/^factory creation code/)
		await expect(check(l1(concat([BODY, meta("01"), args({ ...want, guardian: a(9) })])))).rejects.toThrow(/^factory guardian/)
		await expect(check(l1(concat([BODY, meta("01"), args({ ...want, lifetimeCap: 1n })])))).rejects.toThrow(/^factory cap/)
	})
})
