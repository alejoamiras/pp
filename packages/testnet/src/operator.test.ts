import { EIP1967_IMPLEMENTATION_SLOT, routeSlot } from "@pp/sepolia-fork/pins"
import { type Address, getAddress, type Hex, keccak256, pad } from "viem"
import { describe, expect, it } from "vitest"
import { checkOperator, type OperatorReader, operatorDrift } from "./operator"
import type { TestnetDeployment } from "./schema"

const at = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`)
const PROXY_CODE: Hex = "0x60016001"
const PROXIES = { vault: at(1), entrypoint: at(2), keystore: at(3), aspRegistry: at(4) }
const pool = {
	poolVault: PROXIES.vault,
	entrypoint: PROXIES.entrypoint,
	keystore: PROXIES.keystore,
	aspRegistry: PROXIES.aspRegistry,
	asset: at(9),
	deployBlock: 1n,
	aspApiUrl: "https://api-dev.0xbow.io",
}

/** A chain whose four proxies point at implementations 11 to 14, with verifiers 21 and 22 and a 1% fee. */
function chain() {
	const code = new Map<string, Hex>([
		...Object.values(PROXIES).map((p) => [p, PROXY_CODE] as const),
		...[11, 12, 13, 14, 21, 22].map((n) => [at(n), `0x60${n.toString(16).padStart(2, "0")}`] as const),
	])
	const storage = new Map<string, Hex>(
		Object.values(PROXIES).map((p, i) => [`${p}:${EIP1967_IMPLEMENTATION_SLOT}`, pad(at(11 + i))] as const),
	)
	// The selector sits in bytes 8 to 12 of the route word, the verifier in its low 20 bytes.
	storage.set(`${PROXIES.vault}:${routeSlot(1n, 1n)}`, `0x0000000000000000c9219a7a${at(22).slice(2).toLowerCase()}`)
	const s = { code, storage, verifier: at(21), asset: { enabled: true, minAmount: 1n, vettingFeeBPS: 100n, maxRelayFee: 0n } }
	const reader: OperatorReader = {
		getCode: async ({ address }) => s.code.get(getAddress(address)),
		getStorageAt: async ({ address, slot }) => s.storage.get(`${getAddress(address)}:${slot}`),
		readContract: async ({ functionName }) => (functionName === "depositVerifier" ? s.verifier : s.asset),
		getBlockNumber: async () => 100n,
	}
	return { s, reader }
}

const hash = (n: number) => keccak256(`0x60${n.toString(16).padStart(2, "0")}`)
const contract = (proxy: Address, implementation: number) => ({
	proxy,
	proxyCodeHash: keccak256(PROXY_CODE),
	implementation: at(implementation),
	implementationCodeHash: hash(implementation),
})
const operator: NonNullable<TestnetDeployment["operator"]> = {
	code: {
		vault: contract(PROXIES.vault, 11),
		entrypoint: contract(PROXIES.entrypoint, 12),
		keystore: contract(PROXIES.keystore, 13),
		aspRegistry: contract(PROXIES.aspRegistry, 14),
	},
	depositVerifier: { verifier: at(21), codeHash: hash(21) },
	transactRoute1x1: { verifier: at(22), selector: "0xc9219a7a", codeHash: hash(22) },
	asset: { address: at(9), vettingFeeBps: 100, minDeposit: 1n },
	evidence: { forkBlock: 90, forkBlockHash: `0x${"ab".repeat(32)}` },
}

describe("the operator re-read", () => {
	it("passes a pool that reads as reviewed, and names each field that moved", async () => {
		const { s, reader } = chain()
		expect(await operatorDrift(reader, operator, pool, 100n)).toEqual([])
		s.storage.set(`${PROXIES.entrypoint}:${EIP1967_IMPLEMENTATION_SLOT}`, pad(at(13)))
		s.code.set(at(21), "0x6099")
		s.storage.set(`${PROXIES.vault}:${routeSlot(1n, 1n)}`, `0x0000000000000000deadbeef${at(21).slice(2).toLowerCase()}`)
		s.asset = { ...s.asset, vettingFeeBPS: 50n }
		expect(await operatorDrift(reader, operator, pool, 100n)).toEqual([
			"code.entrypoint.implementation",
			"code.entrypoint.implementationCodeHash",
			"depositVerifier.codeHash",
			"transactRoute1x1.verifier",
			"transactRoute1x1.selector",
			"transactRoute1x1.codeHash",
			"asset.vettingFeeBps",
		])
	})

	it("refuses an operator target with no block or a moved pool before any key, and leaves the own target alone", async () => {
		const { s, reader } = chain()
		expect(await checkOperator(reader, { target: "pool1", operator, pool })).toBe(100n)
		expect(await checkOperator(reader, { target: "own", pool })).toBeUndefined()
		await expect(checkOperator(reader, { target: "pool1", pool })).rejects.toThrow(/operator: target pool1 has no operator section/)
		s.asset = { ...s.asset, enabled: false }
		await expect(checkOperator(reader, { target: "pool1", operator, pool })).rejects.toThrow(
			/operator: the pool moved since block 90, where it was reviewed: asset.enabled differ at block 100/,
		)
	})
})
