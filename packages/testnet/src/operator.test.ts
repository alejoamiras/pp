import { EIP1967_IMPLEMENTATION_SLOT, routeSlot } from "@pp/sepolia-fork/pins"
import { type Address, ContractFunctionRevertedError, getAddress, type Hex, keccak256, pad, toBytes } from "viem"
import { describe, expect, it } from "vitest"
import { checkOperator, type OperatorReader, operatorDrift } from "./operator"
import type { TestnetDeployment } from "./schema"

const at = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`)
const PROXY_CODE: Hex = "0x60016001"
const PROXIES = { vault: at(1), entrypoint: at(2), keystore: at(3), aspRegistry: at(4) }
const ROUTER = at(5)
const BLOCK = 100n
const DEPOSITOR_ROLE = keccak256(toBytes("DEPOSITOR_ROLE"))
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
 * route and ragequit verifiers 21 to 23, the vault live, the entrypoint a depositor and a 1% fee. A getter
 * answers only at its own contract (with its own arguments), and every read only at {@link BLOCK}, so a
 * read aimed at the wrong contract or block fails the test instead of passing on a shared answer.
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
	const getters = new Map<string, unknown>([
		[`${PROXIES.vault}:depositVerifier`, at(21)],
		[`${PROXIES.vault}:ragequitVerifier`, at(23)],
		[`${PROXIES.entrypoint}:poolVault`, PROXIES.vault],
		[`${PROXIES.vault}:keystore`, PROXIES.keystore],
		[`${PROXIES.vault}:aspRegistry`, PROXIES.aspRegistry],
		[`${PROXIES.vault}:paused`, false],
		[`${PROXIES.vault}:ACCESS_ROUTER`, ROUTER],
		[`${ROUTER}:hasRole:${DEPOSITOR_ROLE}:${PROXIES.entrypoint}`, true],
		[`${PROXIES.entrypoint}:assets:${at(9)}`, { enabled: true, minAmount: 1n, vettingFeeBPS: 100n, maxRelayFee: 0n }],
	])
	const reverts = new Set<string>()
	const atBlock = (blockNumber: bigint | undefined, what: string) => {
		if (blockNumber !== BLOCK) throw new Error(`${what} read at block ${blockNumber}, not ${BLOCK}`)
	}
	const reader: OperatorReader = {
		getCode: async ({ address, blockNumber }) => {
			atBlock(blockNumber, `code of ${address}`)
			return code.get(getAddress(address))
		},
		getStorageAt: async ({ address, slot, blockNumber }) => {
			atBlock(blockNumber, `slot ${slot} of ${address}`)
			return storage.get(`${getAddress(address)}:${slot}`)
		},
		readContract: async ({ address, functionName, args = [], blockNumber }) => {
			const key = [getAddress(address), functionName, ...args.map((a) => (a.length === 42 ? getAddress(a) : a))].join(":")
			atBlock(blockNumber, key)
			if (reverts.has(functionName)) throw new ContractFunctionRevertedError({ abi: [], functionName })
			if (!getters.has(key)) throw new Error(`no getter answers ${key}`)
			return getters.get(key)
		},
		getBlockNumber: async () => BLOCK,
	}
	const set = (address: Address, functionName: string, value: unknown) => {
		const key = [...getters.keys()].find((k) => k.startsWith(`${address}:${functionName}`))
		if (!key) throw new Error(`no getter ${functionName} at ${address}`)
		getters.set(key, value)
	}
	const asset = () => getters.get(`${PROXIES.entrypoint}:assets:${at(9)}`) as object
	return { code, storage, set, asset, reverts, reader }
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
		expect(await operatorDrift(c.reader, operator, pool, BLOCK)).toEqual([])
		c.storage.set(`${PROXIES.entrypoint}:${EIP1967_IMPLEMENTATION_SLOT}`, pad(at(13)))
		c.set(PROXIES.entrypoint, "poolVault", at(7))
		c.set(PROXIES.vault, "keystore", at(7))
		c.set(PROXIES.vault, "aspRegistry", at(7))
		// Another deposit verifier with the reviewed one's code: only its address moved.
		c.code.set(at(24), c.code.get(at(21)) as Hex)
		c.set(PROXIES.vault, "depositVerifier", at(24))
		c.code.set(at(23), "0x6098")
		c.storage.set(`${PROXIES.vault}:${routeSlot(1n, 1n)}`, `0x0000000000000000deadbeef${at(21).slice(2).toLowerCase()}`)
		c.set(PROXIES.vault, "paused", true)
		c.set(ROUTER, "hasRole", false)
		c.set(PROXIES.entrypoint, "assets", { ...c.asset(), minAmount: 2n, vettingFeeBPS: 50n })
		expect(await operatorDrift(c.reader, operator, pool, BLOCK)).toEqual([
			"code.entrypoint.implementation",
			"code.entrypoint.implementationCodeHash",
			"wiring.entrypoint.poolVault",
			"wiring.vault.keystore",
			"wiring.vault.aspRegistry",
			"depositVerifier.verifier",
			"ragequitVerifier.codeHash",
			"transactRoute1x1.verifier",
			"transactRoute1x1.selector",
			"transactRoute1x1.codeHash",
			"vault.paused",
			"entrypoint.depositorRole",
			"asset.minDeposit",
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

	it("refuses an operator target with no operator block or a moved pool, and leaves the own target alone", async () => {
		const c = chain()
		expect(await checkOperator(c.reader, { target: "pool1", operator, pool })).toBe(BLOCK)
		expect(await checkOperator(c.reader, { target: "own", pool })).toBeUndefined()
		await expect(checkOperator(c.reader, { target: "pool1", pool })).rejects.toThrow(/operator: target pool1 has no operator section/)
		c.set(PROXIES.entrypoint, "assets", { ...c.asset(), enabled: false })
		await expect(checkOperator(c.reader, { target: "pool1", operator, pool })).rejects.toThrow(
			/operator: the pool moved since block 90, where it was reviewed: asset.enabled differ at block 100/,
		)
	})
})
