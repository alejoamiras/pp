import { expect, test } from "bun:test"
import { dirname, join } from "node:path"
import { type Address, getAddress, type Hex, keccak256, pad, type PublicClient } from "viem"
import { type CodeReader, codeMismatches, EIP1967_IMPLEMENTATION_SLOT, EMPTY_CODE_HASH, POOL_CONTRACTS, readPoolCode } from "./code.ts"
import { TARGETS } from "./pins.ts"

// A viem client is a reader as it stands, so a consumer passes its own (wrapped) client unchanged.
const _clientIsReader = (c: PublicClient): CodeReader => c

const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`)
const POOL = { vault: addr(1), entrypoint: addr(2), keystore: addr(3), aspRegistry: addr(4) }
const IMPL: Record<string, Address> = { [addr(1)]: addr(11), [addr(2)]: addr(12), [addr(3)]: addr(13) }

/** A chain where each pool contract is a proxy to `IMPL`, the ASP registry's slot is cleared, and every read's height is kept. */
function reader() {
	const heights: bigint[] = []
	const client: CodeReader = {
		getCode: async ({ address, blockNumber }) => {
			heights.push(blockNumber)
			return address === addr(0) ? undefined : (`0x60${address.slice(2)}` as Hex)
		},
		getStorageAt: async ({ address, slot, blockNumber }) => {
			heights.push(blockNumber)
			expect(slot).toBe(EIP1967_IMPLEMENTATION_SLOT)
			return pad(IMPL[address] ?? addr(0), { size: 32 })
		},
	}
	return { client, heights }
}

test("reads each proxy, its slot and its implementation at the one block it is given", async () => {
	const { client, heights } = reader()
	const code = await readPoolCode(client, POOL, 12_224_362n)
	expect(heights).toEqual(Array(12).fill(12_224_362n))
	expect(code.keystore).toEqual({
		proxy: addr(3),
		proxyCodeHash: keccak256(`0x60${addr(3).slice(2)}`),
		implementation: addr(13),
		implementationCodeHash: keccak256(`0x60${addr(13).slice(2)}`),
	})
	// A cleared slot is the zero address with empty code, which no pin can equal.
	expect(code.aspRegistry).toMatchObject({ implementation: addr(0), implementationCodeHash: EMPTY_CODE_HASH })
})

test("names exactly the fields that moved, without regard to case", async () => {
	const { client } = reader()
	const want = await readPoolCode(client, POOL, 1n)
	const upper = `0x${want.entrypoint.proxyCodeHash.slice(2).toUpperCase()}` as Hex
	const got = { ...want, vault: { ...want.vault, implementation: addr(99) }, entrypoint: { ...want.entrypoint, proxyCodeHash: upper } }
	expect(codeMismatches(want, got)).toEqual(["code.vault.implementation"])
	expect(codeMismatches(want, want)).toEqual([])
})

test("every pinned contract has code, behind a non-zero implementation", () => {
	for (const [name, target] of Object.entries(TARGETS))
		for (const c of POOL_CONTRACTS) {
			const pin = target.bindings.code[c]
			expect([name, c, pin.proxyCodeHash, pin.implementationCodeHash]).not.toContain(EMPTY_CODE_HASH)
			expect(BigInt(pin.implementation)).not.toBe(0n)
			expect(getAddress(pin.proxy)).toBe(getAddress(target.pool[c]))
		}
})

test("the shared entry loads viem alone at runtime", async () => {
	const transpiler = new Bun.Transpiler({ loader: "ts" })
	const seen = new Set<string>()
	const packages = new Set<string>()
	const walk = async (file: string): Promise<void> => {
		if (seen.has(file)) return
		seen.add(file)
		for (const { path } of transpiler.scan(await Bun.file(file).text()).imports)
			if (path.startsWith(".")) await walk(join(dirname(file), path))
			else packages.add(path)
	}
	await walk(join(import.meta.dir, "pins.ts"))
	expect([...packages]).toEqual(["viem"])
	expect(seen.size).toBe(2)
})
