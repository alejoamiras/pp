import { EIP1967_IMPLEMENTATION_SLOT, routeSlot } from "@pp/sepolia-fork/pins"
import { type Address, ContractFunctionRevertedError, getAddress, type Hex, keccak256, pad } from "viem"
import { describe, expect, it } from "vitest"
import { checkOperator, type OperatorReader, operatorDrift } from "./operator"
import type { TestnetDeployment } from "./schema"

const at = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`)
const PROXY_CODE: Hex = "0x60016001"
const PROXIES = { vault: at(1), entrypoint: at(2), keystore: at(3), aspRegistry: at(4) }
const ROUTER = at(5)
const pool = {
	poolVault: PROXIES.vault,
	entrypoint: PROXIES.entrypoint,
	keystore: PROXIES.keystore,
	aspRegistry: PROXIES.aspRegistry,
	asset: at(9),
	deployBlock: 1n,
	aspApiUrl: "https://api-dev.0xbow.io",
}

/**
 * A chain whose four proxies point at implementations 11 to 14, wired to each other, with deposit,
 * route and ragequit verifiers 21 to 23, the vault live, the entrypoint a depositor and a 1% fee.
 */
function chain() {
	const code = new Map<string, Hex>([
		...Object.values(PROXIES).map((p) => [p, PROXY_CODE] as const),
		...[11, 12, 13, 14, 21, 22, 23].map((n) => [at(n), `0x60${n.toString(16).padStart(2, "0")}`] as const),
	])
	const storage = new Map<string, Hex>(
		Object.values(PROXIES).map((p, i) => [`${p}:${EIP1967_IMPLEMENTATION_SLOT}`, pad(at(11 + i))] as const),
	)
	// The selector sits in bytes 8 to 12 of the route word, the verifier in its low 20 bytes.
	storage.set(`${PROXIES.vault}:${routeSlot(1n, 1n)}`, `0x0000000000000000c9219a7a${at(22).slice(2).toLowerCase()}`)
	const getters: Record<string, unknown> = {
		depositVerifier: at(21),
		ragequitVerifier: at(23),
		poolVault: PROXIES.vault,
		keystore: PROXIES.keystore,
		aspRegistry: PROXIES.aspRegistry,
		paused: false,
		ACCESS_ROUTER: ROUTER,
		hasRole: true,
		assets: { enabled: true, minAmount: 1n, vettingFeeBPS: 100n, maxRelayFee: 0n },
	}
	const reverts = new Set<string>()
	const reader: OperatorReader = {
		getCode: async ({ address }) => code.get(getAddress(address)),
		getStorageAt: async ({ address, slot }) => storage.get(`${getAddress(address)}:${slot}`),
		readContract: async ({ functionName }) => {
			if (reverts.has(functionName)) throw new ContractFunctionRevertedError({ abi: [], functionName })
			return getters[functionName]
		},
		getBlockNumber: async () => 100n,
	}
	return { code, storage, getters, reverts, reader }
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
	ragequitVerifier: { verifier: at(23), codeHash: hash(23) },
	transactRoute1x1: { verifier: at(22), selector: "0xc9219a7a", codeHash: hash(22) },
	asset: { address: at(9), vettingFeeBps: 100, minDeposit: 1n },
	evidence: { forkBlock: 90, forkBlockHash: `0x${"ab".repeat(32)}` },
}

describe("the operator re-read", () => {
	it("passes a pool that reads as reviewed, and names each field that moved", async () => {
		const c = chain()
		expect(await operatorDrift(c.reader, operator, pool, 100n)).toEqual([])
		c.storage.set(`${PROXIES.entrypoint}:${EIP1967_IMPLEMENTATION_SLOT}`, pad(at(13)))
		c.getters.keystore = at(7)
		c.code.set(at(21), "0x6099")
		c.code.set(at(23), "0x6098")
		c.storage.set(`${PROXIES.vault}:${routeSlot(1n, 1n)}`, `0x0000000000000000deadbeef${at(21).slice(2).toLowerCase()}`)
		c.getters.paused = true
		c.getters.hasRole = false
		c.getters.assets = { ...(c.getters.assets as object), vettingFeeBPS: 50n }
		expect(await operatorDrift(c.reader, operator, pool, 100n)).toEqual([
			"code.entrypoint.implementation",
			"code.entrypoint.implementationCodeHash",
			"wiring.vault.keystore",
			"depositVerifier.codeHash",
			"ragequitVerifier.codeHash",
			"transactRoute1x1.verifier",
			"transactRoute1x1.selector",
			"transactRoute1x1.codeHash",
			"vault.paused",
			"entrypoint.depositorRole",
			"asset.vettingFeeBps",
		])
	})

	it("names an upgrade whose getters revert as the code that moved, and the getters as reverted", async () => {
		const c = chain()
		c.storage.set(`${PROXIES.vault}:${EIP1967_IMPLEMENTATION_SLOT}`, pad(at(14)))
		for (const getter of ["depositVerifier", "ragequitVerifier", "paused"]) c.reverts.add(getter)
		await expect(checkOperator(c.reader, { target: "pool1", operator, pool })).rejects.toThrow(
			/operator: .*code\.vault\.implementation, code\.vault\.implementationCodeHash, depositVerifier\.verifier \(reverted\), ragequitVerifier\.verifier \(reverted\), vault\.paused \(reverted\) differ/,
		)
	})

	it("refuses an operator target with no block or a moved pool before any key, and leaves the own target alone", async () => {
		const c = chain()
		expect(await checkOperator(c.reader, { target: "pool1", operator, pool })).toBe(100n)
		expect(await checkOperator(c.reader, { target: "own", pool })).toBeUndefined()
		await expect(checkOperator(c.reader, { target: "pool1", pool })).rejects.toThrow(/operator: target pool1 has no operator section/)
		c.getters.assets = { ...(c.getters.assets as object), enabled: false }
		await expect(checkOperator(c.reader, { target: "pool1", operator, pool })).rejects.toThrow(
			/operator: the pool moved since block 90, where it was reviewed: asset.enabled differ at block 100/,
		)
	})
})
