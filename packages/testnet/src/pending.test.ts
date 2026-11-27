import { type Address, type Hash, TransactionNotFoundError } from "viem"
import { describe, expect, it } from "vitest"
import { GuardError } from "./errors"
import { nonceOf, pendingToReplace, replaceArgs, type TxReader } from "./pending"

const HASH = `0x${"ab".repeat(32)}` as Hash
const GUARDIAN = "0x00000000000000000000000000000000000000a1" as Address
const OTHER = "0x00000000000000000000000000000000000000b2" as Address

type Known = {
	from: Address
	nonce: number
	blockNumber: bigint | null
	chainId?: number
	gasPrice?: bigint
	maxFeePerGas?: bigint
	maxPriorityFeePerGas?: bigint
}

/** An endpoint that knows `tx` (or nothing) and counts the guardian's nonces as `latest` and `pending`. */
function reader(tx: Known | undefined, counts = { latest: 3, pending: 3 }): TxReader {
	return {
		getTransaction: async () => {
			if (!tx) throw new TransactionNotFoundError({ hash: HASH })
			return { hash: HASH, ...tx }
		},
		getTransactionCount: async ({ blockTag }: { blockTag: "latest" | "pending" }) => counts[blockTag],
	} as unknown as TxReader
}

const pendingAt3 = { from: GUARDIAN, nonce: 3, blockNumber: null, chainId: 11155111, maxFeePerGas: 500n, maxPriorityFeePerGas: 50n }
const query = (readers: TxReader[]) => ({ readers, hash: HASH, guardian: GUARDIAN, nonce: 3, chainId: 11155111 })
const refusal = (readers: TxReader[]) => pendingToReplace(query(readers)).catch((e: unknown) => e)

describe("pendingToReplace", () => {
	it("takes the guardian's pending transaction from the first endpoint that knows it, legacy fees included", async () => {
		await expect(pendingToReplace(query([reader(undefined), reader(pendingAt3)]))).resolves.toEqual({
			hash: HASH,
			from: GUARDIAN,
			nonce: 3,
			maxFeePerGas: 500n,
			maxPriorityFeePerGas: 50n,
		})
		const legacy = { from: GUARDIAN, nonce: 3, blockNumber: null, gasPrice: 70n }
		await expect(pendingToReplace(query([reader(legacy)]))).resolves.toMatchObject({ maxFeePerGas: 70n, maxPriorityFeePerGas: 70n })
	})

	it("refuses another account's transaction, one at another nonce, and one that mined", async () => {
		for (const [tx, why] of [
			[{ ...pendingAt3, from: OTHER }, `is from ${OTHER}, not the guardian`],
			[{ ...pendingAt3, nonce: 4 }, "is at nonce 4, not 3"],
			[{ ...pendingAt3, blockNumber: 9n }, "mined in block 9"],
		] as const) {
			const e = await refusal([reader(tx)])
			expect(e).toBeInstanceOf(GuardError)
			expect((e as Error).message).toContain(why)
		}
	})

	it("refuses a hash no endpoint knows, naming what to run from the file's endpoint's nonce counts", async () => {
		const ask = async (counts: { latest: number; pending: number }) =>
			((await refusal([reader(undefined, counts), reader(undefined)])) as Error).message
		expect(await ask({ latest: 4, pending: 4 })).toMatch(/nonce 3 has mined: run `pause` without --nonce/)
		expect(await ask({ latest: 3, pending: 3 })).toMatch(/nothing is pending at nonce 3: run `pause --nonce 3` without --replace/)
		expect(await ask({ latest: 3, pending: 4 })).toMatch(/a transaction is pending at nonce 3: pass its hash/)
	})

	it("fails rather than refuses when an endpoint could not be read", async () => {
		const down = { ...reader(undefined), getTransaction: async () => Promise.reject(new Error("fetch failed")) } as TxReader
		const e = await refusal([down, reader(undefined)])
		expect(e).not.toBeInstanceOf(GuardError)
		expect((e as Error).message).toMatch(/reading one failed: fetch failed/)
	})
})

describe("replaceArgs", () => {
	it("reads an empty --nonce as no number, and pairs --replace with --nonce and --pending", () => {
		expect(() => nonceOf("")).toThrow(GuardError)
		expect(() => nonceOf("01")).toThrow(GuardError)
		expect(nonceOf("0")).toBe(0)
		expect(() => replaceArgs({ nonce: "3", replace: true })).toThrow(/needs --pending/)
		expect(() => replaceArgs({ replace: true, pending: HASH })).toThrow(/needs --nonce/)
		expect(() => replaceArgs({ nonce: "3", pending: HASH })).toThrow(/--pending goes with --replace/)
		expect(replaceArgs({ nonce: "3", replace: true, pending: HASH })).toEqual({ nonce: 3, pending: HASH })
	})
})
