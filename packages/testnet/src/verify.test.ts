import { type Address, concat, encodeAbiParameters, type Hex, keccak256, numberToHex, type PublicClient, size } from "viem"
import { describe, expect, it, vi } from "vitest"

const meta = (seed: string): Hex => concat([keccak256(`0x${seed}`), numberToHex(32, { size: 2 })])
const BODY: Hex = "0x60806040526004361061"

vi.mock("./creation", async (actual) => {
	const real = await actual<typeof import("./creation")>()
	const code = concat([BODY, meta("01")])
	return { ...real, CREATION_CODES: { PortalFactory: { hash: real.creationCodeHash(code), size: size(code) } } }
})

const { checkDeployBlock, checkFactoryCreation } = await import("./verify")

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address
const CREATED_AT = 100n
const want = {
	deployer: a(1),
	registry: a(2),
	hub: `0x${"ab".repeat(32)}` as Hex,
	pool: a(3),
	lifetimeCap: 10n ** 9n,
	guardian: a(4),
	deployBlock: CREATED_AT,
}
const FACTORY = a(5)
const args = (o: typeof want) =>
	encodeAbiParameters(
		[{ type: "address" }, { type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "address" }],
		[o.registry, o.hub, o.pool, o.lifetimeCap, o.guardian],
	)
const l1 = (input: Hex, from: Address = want.deployer) =>
	({
		getTransaction: async () => ({ from, to: null, input }),
		getTransactionReceipt: async () => ({ contractAddress: FACTORY, blockNumber: CREATED_AT }),
	}) as unknown as PublicClient
const check = (client: PublicClient, expectation = want) => checkFactoryCreation(client, `0x${"cd".repeat(32)}`, FACTORY, expectation)

describe("the factory's creation transaction", () => {
	it("passes with the committed code under other metadata and exactly the expected arguments", async () => {
		await expect(check(l1(concat([BODY, meta("02"), args(want)])))).resolves.toBeUndefined()
	})

	it("reads the arguments where the constructor does, at the pinned code's size, whatever metadata length the input claims", async () => {
		// The constructor reads `args(evil)` at the pinned size; the claimed metadata length hides it from a split from the end.
		const evil = args({ ...want, guardian: a(9) })
		const hidden = concat([meta("01"), evil])
		const input = concat([BODY, hidden, numberToHex(size(hidden), { size: 2 }), args(want)])
		await expect(check(l1(input))).rejects.toThrow(/^factory creation: the input is/)
	})

	it("refuses a bridge deploy block after the factory's creation, from which discovery misses PortalCreated", async () => {
		const input = concat([BODY, meta("01"), args(want)])
		await expect(check(l1(input), { ...want, deployBlock: CREATED_AT })).resolves.toBeUndefined()
		await expect(check(l1(input), { ...want, deployBlock: CREATED_AT + 1n })).rejects.toThrow(/^bridge deploy block/)
	})

	it("names the first field that differs: creator, code, then each argument", async () => {
		await expect(check(l1(concat([BODY, meta("01"), args(want)]), a(9)))).rejects.toThrow(/^factory creator/)
		await expect(check(l1(concat(["0x60806040526004361062", meta("01"), args(want)])))).rejects.toThrow(/^factory creation code/)
		await expect(check(l1(concat([BODY, meta("01"), args({ ...want, guardian: a(9) })])))).rejects.toThrow(/^factory guardian/)
		await expect(check(l1(concat([BODY, meta("01"), args({ ...want, lifetimeCap: 1n })])))).rejects.toThrow(/^factory cap/)
	})
})

describe("the deploy block", () => {
	const D = 5_000_000n
	const pool = { poolVault: a(6), keystore: a(7), entrypoint: a(8), aspRegistry: a(9), asset: a(10), deployBlock: D }
	const chain = (o: { codeAt?: Address; logsAt?: bigint; pruned?: boolean } = {}) =>
		({
			getCode: async ({ address }: { address: Address }) => {
				if (o.pruned) throw new Error("pruned history unavailable")
				return address === o.codeAt ? "0x60806040" : undefined
			},
			getBlockNumber: async () => D + 20_000n,
			getLogs: async () => (o.logsAt === undefined ? [] : [{ blockNumber: o.logsAt }]),
		}) as unknown as PublicClient

	it("passes when no pool contract predates it and the vault's Initialized log is served from it", async () => {
		await expect(checkDeployBlock(chain({ logsAt: D + 3n }), pool)).resolves.toBe(D + 3n)
	})

	it("refuses an older keystore, a pruned endpoint, a missing Initialized log and block 0", async () => {
		await expect(checkDeployBlock(chain({ codeAt: a(7), logsAt: D }), pool)).rejects.toThrow(/keystore .* has code at block 4999999/)
		await expect(checkDeployBlock(chain({ pruned: true }), pool)).rejects.toThrow(/serves no state at block 4999999/)
		await expect(checkDeployBlock(chain(), pool)).rejects.toThrow(/no Initialized log in blocks 5000000 to 5009999/)
		await expect(checkDeployBlock(chain({ logsAt: 1n }), { ...pool, deployBlock: 0n })).rejects.toThrow(/scan from genesis/)
	})
})
