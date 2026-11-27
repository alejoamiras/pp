import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { type Address, encodeAbiParameters, type Hex, keccak256, type PublicClient, padHex, toHex } from "viem"
import { checkPoolCode } from "./code.ts"
import type { PoolCodeTargets } from "./types.ts"

const SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
const ANNOUNCER: Address = "0x55649E01B5Df198D18D95b5cc5051630cfD45564"
const UUPS = ["Keystore", "ASPRegistry", "PoolVault", "Entrypoint"] as const
const SHAPES = [1, 2, 3, 4, 5].flatMap((n) => [1, 2, 3, 4, 5].map((m) => [n, m] as const))
const IDS: Record<string, readonly string[]> = {
	...Object.fromEntries(UUPS.map((n) => [n, ["self", "router"]])),
	PrivacyPoolRelay: ["pool", "entrypoint", "announcer"],
}
const GETTER_ID: Record<string, string> = { ACCESS_ROUTER: "router", POOL: "pool", ENTRYPOINT: "entrypoint", ANNOUNCER: "announcer" }

const addr = (n: number): Address => padHex(toHex(n), { size: 20 })
const selectorOf = (n: number, m: number) => keccak256(toHex(`verifyProof(uint256[${n + m + 6}])`)).slice(0, 10) as Hex
const routeKey = (n: number, m: number) =>
	keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(n), BigInt(m)]))

/** A build of 8 bytes unique to `name`, then two 32-byte references per immutable. */
function artifact(name: string, ids: readonly string[] = [], extra: object = {}) {
	const immutableReferences: Record<string, { start: number; length: number }[]> = {}
	ids.forEach((id, i) => {
		immutableReferences[id] = [0, 1].map((k) => ({ start: 8 + 64 * i + 32 * k, length: 32 }))
	})
	const object = `${keccak256(toHex(name)).slice(0, 18)}${"00".repeat(64 * ids.length)}`
	return { deployedBytecode: { object, linkReferences: {}, immutableReferences }, ...extra }
}

/** `name`'s runtime with each immutable's references holding `values[id]`. */
function runtime(name: string, values: Record<string, Hex> = {}): Hex {
	const words = (IDS[name] ?? []).map((id) =>
		padHex(values[id] as Hex)
			.slice(2)
			.repeat(2),
	)
	return `${keccak256(toHex(name)).slice(0, 18)}${words.join("")}` as Hex
}

type Route = { addr: Address; selector: Hex }
/** A chain whose deployed contracts hold what the deploy produces. */
function honest() {
	const code = new Map<string, Hex>()
	const values = new Map<string, Record<string, Hex>>()
	const slots = new Map<string, Hex>()
	const routes = new Map<Hex, Route>()
	const deploy = (at: Address, name: string, v: Record<string, Hex> = {}) => {
		code.set(at.toLowerCase(), runtime(name, v))
		values.set(at.toLowerCase(), v)
	}
	const d: PoolCodeTargets = {
		accessRouter: addr(1),
		relay: addr(2),
		keystore: addr(3),
		aspRegistry: addr(4),
		pool: addr(5),
		entrypoint: addr(6),
		asset: addr(7),
	}
	deploy(d.accessRouter, "AccessRouter")
	deploy(d.relay, "PrivacyPoolRelay", { pool: d.pool, entrypoint: d.entrypoint, announcer: ANNOUNCER })
	UUPS.forEach((name, i) => {
		const proxy = [d.keystore, d.aspRegistry, d.pool, d.entrypoint][i] as Address
		const impl = addr(13 + i)
		deploy(proxy, "ERC1967Proxy")
		slots.set(proxy.toLowerCase(), padHex(impl))
		deploy(impl, name, { self: impl, router: d.accessRouter })
	})
	deploy(addr(20), "DepositVerifier")
	deploy(addr(21), "RagequitVerifier")
	SHAPES.forEach(([n, m], i) => {
		deploy(addr(30 + i), `Transact${n}x${m}Verifier`)
		routes.set(routeKey(n, m), { addr: addr(30 + i), selector: selectorOf(n, m) })
	})
	deploy(d.asset, "TestToken")
	const read = ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
		const at = address.toLowerCase()
		const v = values.get(at) ?? {}
		if (functionName === "depositVerifier") return addr(20)
		if (functionName === "ragequitVerifier") return addr(21)
		if (functionName === "verifiers") return routes.get(args?.[0] as Hex)
		if (functionName === "proxiableUUID") {
			if (v.self?.toLowerCase() !== at) throw new Error("execution reverted: UUPSUnauthorizedCallContext()")
			return SLOT
		}
		return v[GETTER_ID[functionName] as string]
	}
	const client = {
		getCode: async ({ address }: { address: Address }) => code.get(address.toLowerCase()),
		getStorageAt: async ({ address }: { address: Address }) => slots.get(address.toLowerCase()),
		readContract: async (r: Parameters<typeof read>[0]) => read(r),
	} as unknown as PublicClient
	return { d, code, routes, deploy, client, fixtures: "fixtures" }
}

let dir: string
let outs: { pool: string; fixtures: string }
beforeAll(async () => {
	const parent = join(homedir(), ".cache/pp/pp-env")
	await mkdir(parent, { recursive: true })
	dir = await mkdtemp(join(parent, "code-test-"))
	outs = { pool: join(dir, "pool"), fixtures: join(dir, "fixtures") }
	const put = async (out: string, file: string, name: string, a: object) => {
		await mkdir(join(out, file), { recursive: true })
		await writeFile(join(out, file, `${name}.json`), JSON.stringify(a))
	}
	for (const name of ["AccessRouter", "PrivacyPoolRelay", "ERC1967Proxy", ...UUPS])
		await put(outs.pool, `${name}.sol`, name, artifact(name, IDS[name]))
	for (const name of ["DepositVerifier", "RagequitVerifier"]) await put(outs.pool, "VerifierArtifacts.sol", name, artifact(name))
	for (const [n, m] of SHAPES) {
		const methodIdentifiers = { [`verifyProof(uint256[${n + m + 6}])`]: selectorOf(n, m).slice(2) }
		await put(
			outs.pool,
			"VerifierArtifacts.sol",
			`Transact${n}x${m}Verifier`,
			artifact(`Transact${n}x${m}Verifier`, [], { methodIdentifiers }),
		)
	}
	await put(outs.fixtures, "TestToken.sol", "TestToken", artifact("TestToken"))
	await put(join(dir, "fixtures-immutable"), "TestToken.sol", "TestToken", artifact("TestToken", ["minter"]))
})
afterAll(() => rm(dir, { recursive: true, force: true }))

test("an honest deployment matches: every contract, the 27 verifiers and the test token", async () => {
	const { d, client } = honest()
	const matched = await checkPoolCode(client, d, 1n, outs)
	expect(matched).toHaveLength(2 + 2 * UUPS.length + 27 + 1)
	expect(matched.at(-1)).toEqual({ name: "TestToken", address: d.asset })
})

type World = ReturnType<typeof honest>
const FAULTS: [string, (w: World) => void, RegExp][] = [
	[
		"a route to another shape's verifier",
		(w) => w.routes.set(routeKey(2, 2), { addr: addr(30), selector: selectorOf(2, 2) }),
		/Transact2x2Verifier at \S+ is not the build's/,
	],
	[
		"a route calling another selector",
		(w) => w.routes.set(routeKey(3, 3), { addr: addr(42), selector: selectorOf(1, 1) }),
		/routes 3x3 proofs to selector/,
	],
	[
		"a registry wired to another access router",
		(w) => w.deploy(addr(14), "ASPRegistry", { self: addr(14), router: addr(99) }),
		/ASPRegistry at \S+: ACCESS_ROUTER\(\) is \S+, not/,
	],
	[
		"an implementation whose own-address immutable is another address",
		(w) => w.deploy(addr(15), "PoolVault", { self: addr(98), router: addr(1) }),
		/PoolVault at \S+: proxiableUUID\(\) fails/,
	],
	[
		"a relay wired to another vault",
		(w) => w.deploy(addr(2), "PrivacyPoolRelay", { pool: addr(97), entrypoint: addr(6), announcer: ANNOUNCER }),
		/PrivacyPoolRelay at \S+: POOL\(\) is/,
	],
	[
		"an immutable whose references disagree",
		(w) => {
			const at = addr(13).toLowerCase()
			const c = w.code.get(at) as Hex
			// The access router's second reference starts at byte 8 + 64 + 32.
			w.code.set(at, `${c.slice(0, 2 + 2 * 104)}${padHex(addr(99)).slice(2)}` as Hex)
		},
		/Keystore at \S+ is not the build's: immutable router holds different values/,
	],
	["a test token that is not pp-env's", (w) => w.deploy(addr(7), "AccessRouter"), /TestToken at \S+ is not the build's/],
	[
		"a build with an immutable nothing pins",
		(w) => {
			w.code.set(addr(7).toLowerCase(), `${keccak256(toHex("TestToken")).slice(0, 18)}${"00".repeat(64)}` as Hex)
			w.fixtures = "fixtures-immutable"
		},
		/TestToken carries 1 immutables and 0 are pinned/,
	],
]

test.each(FAULTS)("refuses %s", async (_, fault, message) => {
	const w = honest()
	fault(w)
	await expect(checkPoolCode(w.client, w.d, 1n, { ...outs, fixtures: join(dir, w.fixtures) })).rejects.toThrow(message)
})
