import { type Address, type Hash, type Hex, keccak256, parseTransaction, TransactionNotFoundError } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { describe, expect, it } from "vitest"
import { GuardError } from "./errors"
import { nonceOf, pendingToReplace, replaceArgs, type TxReader } from "./pending"

// anvil's well-known keys 1 and 2
const GUARDIAN_ACCOUNT = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d")
const OTHER_ACCOUNT = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a")
const GUARDIAN = GUARDIAN_ACCOUNT.address
const SEPOLIA = 11155111
const FACTORY = "0x00000000000000000000000000000000000000f1" as Address

type Record = { [k: string]: unknown; hash: Hash; blockNumber: bigint | null }

/** A transaction really signed by `o.account` (the guardian's by default), as an endpoint returns it. */
async function signed(o: { account?: typeof GUARDIAN_ACCOUNT; nonce?: number; chainId?: number; legacy?: boolean; tip?: bigint } = {}) {
	const account = o.account ?? GUARDIAN_ACCOUNT
	const common = { chainId: o.chainId ?? SEPOLIA, nonce: o.nonce ?? 3, to: FACTORY, gas: 60_000n, value: 0n, data: "0x1234" as Hex }
	const raw = await account.signTransaction(
		o.legacy
			? { ...common, type: "legacy", gasPrice: 70n }
			: { ...common, type: "eip1559", maxFeePerGas: 500n, maxPriorityFeePerGas: o.tip ?? 50n },
	)
	const t = parseTransaction(raw)
	const hash = keccak256(raw)
	const tx: Record = { ...t, input: t.data, accessList: t.accessList ?? [], from: account.address, blockNumber: null, hash }
	return { hash, tx }
}

/** An endpoint that answers every hash with `tx` (or knows nothing) and counts the guardian's nonces as `latest` and `pending`. */
function reader(tx: Record | undefined, counts = { latest: 3, pending: 3 }): TxReader {
	return {
		getTransaction: async ({ hash }: { hash: Hash }) => {
			if (!tx) throw new TransactionNotFoundError({ hash })
			return tx
		},
		getTransactionCount: async ({ blockTag }: { blockTag: "latest" | "pending" }) => counts[blockTag],
	} as unknown as TxReader
}

const query = (readers: TxReader[], hash: Hash) => ({ readers, hash, guardian: GUARDIAN, nonce: 3, chainId: SEPOLIA })
const refusal = (readers: TxReader[], hash: Hash) => pendingToReplace(query(readers, hash)).catch((e: unknown) => e)
const refusedWith = async (readers: TxReader[], hash: Hash, why: string) => {
	const e = await refusal(readers, hash)
	expect(e).toBeInstanceOf(GuardError)
	expect((e as Error).message).toContain(why)
}

describe("pendingToReplace", () => {
	it("takes the guardian's pending transaction from the first endpoint that knows it, legacy fees included", async () => {
		const p = await signed()
		await expect(pendingToReplace(query([reader(undefined), reader(p.tx)], p.hash))).resolves.toEqual({
			hash: p.hash,
			from: GUARDIAN,
			nonce: 3,
			maxFeePerGas: 500n,
			maxPriorityFeePerGas: 50n,
		})
		const legacy = await signed({ legacy: true })
		await expect(pendingToReplace(query([reader(legacy.tx)], legacy.hash))).resolves.toMatchObject({
			maxFeePerGas: 70n,
			maxPriorityFeePerGas: 70n,
		})
	})

	it("refuses an answer whose fields are not the signed transaction, so no endpoint can name the fees", async () => {
		const p = await signed()
		await refusedWith([reader({ ...p.tx, maxPriorityFeePerGas: 5_000n })], p.hash, "do not hash to it")
		const other = await signed({ nonce: 4 })
		await refusedWith([reader(other.tx)], p.hash, "do not hash to it")
		// The endpoint names the guardian as sender, but another key signed it.
		const forged = await signed({ account: OTHER_ACCOUNT })
		await refusedWith([reader({ ...forged.tx, from: GUARDIAN })], forged.hash, `is signed by ${OTHER_ACCOUNT.address}`)
	})

	it("reads fees, chain and nonce from the signed bytes, not from fields an endpoint can leave out or rename", async () => {
		// A signed zero tip serializes the same whether the endpoint sends it or omits it for a gasPrice.
		const zero = await signed({ tip: 0n })
		const { maxPriorityFeePerGas: _, ...omitted } = zero.tx
		await expect(pendingToReplace(query([reader({ ...omitted, gasPrice: 9_000n })], zero.hash))).resolves.toMatchObject({
			maxFeePerGas: 500n,
			maxPriorityFeePerGas: 0n,
		})
		// A legacy signature's `v` names its chain, whatever chain id the endpoint reports beside it.
		const mainnet = await signed({ legacy: true, chainId: 1 })
		await refusedWith([reader({ ...mainnet.tx, chainId: SEPOLIA })], mainnet.hash, "is a chain 1 transaction")
	})

	it("refuses another chain's transaction, one at another nonce, and one that mined", async () => {
		const c = await signed({ chainId: 1 })
		await refusedWith([reader(c.tx)], c.hash, "is a chain 1 transaction")
		const n = await signed({ nonce: 4 })
		await refusedWith([reader(n.tx)], n.hash, "is at nonce 4, not 3")
		const m = await signed()
		await refusedWith([reader({ ...m.tx, blockNumber: 9n })], m.hash, "mined in block 9")
	})

	it("refuses a hash no endpoint knows, naming what to run from the file's endpoint's nonce counts", async () => {
		const { hash } = await signed()
		const ask = async (counts: { latest: number; pending: number }) =>
			((await refusal([reader(undefined, counts), reader(undefined)], hash)) as Error).message
		expect(await ask({ latest: 4, pending: 4 })).toMatch(/nonce 3 has mined: run `pause` without --nonce/)
		expect(await ask({ latest: 2, pending: 2 })).toMatch(/nonce 3 is past the guardian's next nonce 2: run `pause` without --nonce/)
		expect(await ask({ latest: 3, pending: 3 })).toMatch(/nothing is pending at nonce 3: run `pause --nonce 3` without --replace/)
		expect(await ask({ latest: 3, pending: 4 })).toMatch(/a transaction is pending at nonce 3: pass its hash/)
	})

	it("fails rather than refuses when an endpoint could not be read", async () => {
		const { hash } = await signed()
		const down = { ...reader(undefined), getTransaction: async () => Promise.reject(new Error("fetch failed")) } as TxReader
		const e = await refusal([down, reader(undefined)], hash)
		expect(e).not.toBeInstanceOf(GuardError)
		expect((e as Error).message).toMatch(/reading one failed: fetch failed/)
	})
})

const HASH = `0x${"ab".repeat(32)}` as Hash

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
