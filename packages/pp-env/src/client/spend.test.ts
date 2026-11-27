import { expect, test } from "bun:test"
import type { PreparedSpend as ClientSpend } from "@pp/pool-client"
import { getAddress } from "viem"
import { poolClientOptions, toPreparedSpend } from "./spend.ts"
import type { ClientConfig } from "./types.ts"

// pp-env's viem and pool-client's are different copies, so only plain data may cross between them;
// test/types/boundary.ts pins the same at the type level.
/** Throws on anything but primitives, arrays and plain objects, naming the first offending path. */
function assertPlain(v: unknown, path = "$"): void {
	if (v === null || ["string", "number", "bigint", "boolean", "undefined"].includes(typeof v)) return
	if (Array.isArray(v)) {
		for (const [i, x] of v.entries()) assertPlain(x, `${path}[${i}]`)
		return
	}
	const proto = typeof v === "object" ? Object.getPrototypeOf(v) : undefined
	if (proto !== Object.prototype && proto !== null) throw new Error(`${path} is not plain data (${typeof v})`)
	for (const [k, x] of Object.entries(v as object)) assertPlain(x, `${path}.${k}`)
}

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`)
const config: ClientConfig = {
	rpcUrl: "http://127.0.0.1:8545",
	chainId: 31337,
	aspUrl: "http://127.0.0.1:3000",
	circuitsDir: "/circuits",
	deployment: { pool: addr(1), entrypoint: addr(2), keystore: addr(3), aspRegistry: addr(4), deployBlock: 7n },
}

test("the options pp-env hands pool-client are plain data drawn from the user's config", () => {
	const signature = `0x${"ab".repeat(65)}` as const
	const options = poolClientOptions(config, addr(5), addr(6), signature)
	assertPlain(options)
	expect(options).toEqual({
		pool: {
			chainId: 31337,
			l1Rpc: config.rpcUrl,
			poolVault: addr(1),
			entrypoint: addr(2),
			aspRegistry: addr(4),
			keystore: addr(3),
			asset: addr(5),
			deployBlock: 7n,
			aspApiUrl: config.aspUrl,
		},
		l1Address: addr(6),
		signature,
		artifacts: { kind: "dir", path: "/circuits" },
	})
})

test("a pool-client spend comes back as plain data in PoolUser's shape, transact's arguments intact", () => {
	const proof = {
		pA: [1n, 2n],
		pB: [
			[3n, 4n],
			[5n, 6n],
		],
		pC: [7n, 8n],
		pubSignals: [[9n, 10n]],
	} as const
	const noteData = [{ hint: "0x01", data: "0x02" }] as const
	const lowerAsset = "0x00000000000000000000000000000000000abcde"
	expect(getAddress(lowerAsset)).not.toBe(lowerAsset)
	const spend: ClientSpend = Object.freeze({
		proof,
		noteData,
		processor: addr(7),
		data: "0xbeef",
		nullifier: 11n,
		spentCommitment: 12n,
		change: { commitment: 13n, precommitment: 14n, label: 15n, value: 16n },
		amount: 17n,
		asset: lowerAsset,
		aspRoot: 18n,
	})
	const prepared = toPreparedSpend(spend)
	assertPlain(prepared)
	expect(prepared).toEqual({
		args: [proof, { processor: addr(7), data: "0xbeef" }, noteData],
		input: 12n,
		nullifier: 11n,
		changeCommitment: 13n,
		changeValue: 16n,
		amountOut: 17n,
		asset: getAddress(lowerAsset),
		label: 15n,
	})
})

test("the plain-data check refuses a client-shaped value", () => {
	expect(() => assertPlain({ pool: { client: new (class Client {})() } })).toThrow("$.pool.client is not plain data")
	expect(() => assertPlain([() => 1])).toThrow("$[0] is not plain data")
})
