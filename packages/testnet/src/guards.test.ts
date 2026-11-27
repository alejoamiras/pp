import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Address, Hex } from "viem"
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts"
import { describe, expect, it } from "vitest"
import {
	accountHome,
	assertL1Chain,
	assertNode,
	assertScratchKeyFile,
	assertTransport,
	type GuardError,
	type Mode,
	readKeys,
} from "./guards"
import { keyFilePath } from "./keyfile"
import { redact } from "./redact"
import { scratchHome, writeKeyFile } from "./test-support"
import { toStackManifest } from "./manifest"
import { loopback } from "./network"
import { parseDeployment, serializeDeployment, type TestnetDeployment } from "./schema"

const DIR = fileURLToPath(new URL("../deployments/", import.meta.url))
const committed = readdirSync(DIR).map((f) => [f, JSON.parse(readFileSync(`${DIR}${f}`, "utf8"))] as const)
const own = parseDeployment(committed.find(([f]) => f === "testnet-own.json")?.[1])
const LIVE: Mode = { kind: "live" }
const REHEARSE: Mode = { kind: "rehearse", manifest: "/m.json" }
const FORK: Mode = { kind: "rehearse-fork", url: "http://127.0.0.1:1" }

const withNetwork = (n: Partial<TestnetDeployment["network"]>): TestnetDeployment => ({ ...own, network: { ...own.network, ...n } })
const refusedBy = (guard: string) => expect.objectContaining({ name: "GuardError", guard })
const addressOf = (k: Hex) => privateKeyToAccount(k).address

describe("the deployment file", () => {
	it.each(committed)("%s parses, round-trips, and passes the live transport guard", (_, json) => {
		const d = parseDeployment(json)
		expect(parseDeployment(JSON.parse(serializeDeployment(d)))).toEqual(d)
		expect(() => assertTransport(d, LIVE, true)).not.toThrow()
	})

	it("refuses an unknown key, an own pool without an ASP port, the ceremony bundle or its code-check addresses, and an ASP URL that is not the target's", () => {
		expect(() => parseDeployment({ ...own, extra: 1 })).toThrow(/extra/)
		const { aspPort: _, ...noPort } = own.network
		expect(() => parseDeployment({ ...own, network: noPort })).toThrow(/aspPort/)
		const pool = {
			poolVault: own.network.rollup,
			entrypoint: own.network.rollup,
			aspRegistry: own.network.rollup,
			keystore: own.network.rollup,
			asset: own.network.rollup,
			deployBlock: "1",
			aspApiUrl: "https://api-dev.0xbow.io",
			accessRouter: own.network.rollup,
			relay: own.network.rollup,
		}
		expect(() => parseDeployment({ ...committed[0]?.[1], bundle: "pre-ceremony" })).toThrow(/bundle/)
		const { relay: _r, ...noRelay } = pool
		expect(() =>
			parseDeployment({ ...committed[0]?.[1], pool: { ...noRelay, aspApiUrl: loopback(own.network.aspPort as number) } }),
		).toThrow(/access router and relay/)
		expect(() => parseDeployment(JSON.parse(serializeDeployment({ ...own })) && { ...committed[0]?.[1], pool })).toThrow(/aspApiUrl/)
		expect(
			parseDeployment({ ...committed[0]?.[1], pool: { ...pool, aspApiUrl: loopback(own.network.aspPort as number) } }).pool
				?.aspApiUrl,
		).toBe(loopback(own.network.aspPort as number))
	})

	it("projects a stack manifest without the factory's transaction once pool and bridge exist", () => {
		expect(() => toStackManifest(own)).toThrow(/no pool, bridge sections/)
		const word = `0x${"11".repeat(32)}` as Hex
		const a = own.network.rollup
		const d: TestnetDeployment = {
			...own,
			pool: {
				poolVault: a,
				entrypoint: a,
				aspRegistry: a,
				keystore: a,
				asset: a,
				deployBlock: 5n,
				aspApiUrl: loopback(own.network.aspPort as number),
			},
			bridge: { factory: a, portal: a, hub: word, token: word, registry: word, deployBlock: 6n, factoryTx: word },
		}
		const m = toStackManifest(d)
		expect(m).toMatchObject({ chainId: 11155111, l1Rpc: own.network.l1Rpc, bridge: { deployBlock: 6n } })
		expect(m.bridge).not.toHaveProperty("factoryTx")
		expect(m.bot).toBeUndefined()
	})
})

describe("the guards", () => {
	it("pins live URLs by equality and keeps a rehearsal on loopback and chain 31337", () => {
		expect(() => assertTransport(withNetwork({ l1Rpc: "https://ethereum-sepolia-rpc.publicnode.com/" }), LIVE, true)).toThrow(
			refusedBy("transport"),
		)
		expect(() => assertTransport(withNetwork({ aztecNode: "https://evil.example" }), LIVE, true)).toThrow(refusedBy("transport"))
		const local = withNetwork({ l1ChainId: 31337, l1Rpc: "http://127.0.0.1:8545", aztecNode: "http://127.0.0.1:8080" })
		expect(() => assertTransport(local, REHEARSE, true)).not.toThrow()
		expect(() => assertTransport(local, LIVE, true)).toThrow(refusedBy("transport"))
		expect(() => assertTransport(own, REHEARSE, true)).toThrow(refusedBy("transport"))
		const fork: Mode = { kind: "rehearse-fork", url: "http://127.0.0.1:9545" }
		expect(() => assertTransport(withNetwork({ l1Rpc: "http://127.0.0.1:9545" }), fork, false)).not.toThrow()
		expect(() => assertTransport(own, fork, false)).toThrow(refusedBy("transport"))
	})

	it("refuses mainnet by name and any chain but the mode's", async () => {
		const at = (id: number) => ({ getChainId: async () => id })
		await expect(assertL1Chain(at(1), LIVE)).rejects.toThrow(/mainnet/)
		await expect(assertL1Chain(at(31337), LIVE)).rejects.toThrow(refusedBy("chain"))
		await expect(assertL1Chain(at(11155111), REHEARSE)).rejects.toThrow(refusedBy("chain"))
		await expect(assertL1Chain(at(11155111), LIVE)).resolves.toBeUndefined()
	})

	it.each(["rollupAddress", "registryAddress", "inboxAddress", "outboxAddress"] as const)(
		"refuses a node whose %s is not the file's",
		async (field) => {
			const n = own.network
			const addresses = { rollupAddress: n.rollup, registryAddress: n.l1Registry, inboxAddress: n.inbox, outboxAddress: n.outbox }
			const info = { l1ChainId: n.l1ChainId, rollupVersion: n.rollupVersion, l1ContractAddresses: addresses }
			await expect(assertNode({ getNodeInfo: async () => info }, own)).resolves.toBeUndefined()
			const moved = {
				...info,
				l1ContractAddresses: { ...addresses, [field]: "0x000000000000000000000000000000000000dEaD" as Address },
			}
			await expect(assertNode({ getNodeInfo: async () => moved }, own)).rejects.toThrow(refusedBy("node"))
		},
	)

	it("reads the key file live and on a fork (a scratch one only), the environment on the local stack, and never echoes a value", () => {
		const key = generatePrivateKey()
		const spec = [{ name: "GUARDIAN_KEY", kind: "l1" }] as const
		const home = scratchHome()
		const file = writeKeyFile(home, [`GUARDIAN_KEY=${key}`])
		expect(readKeys(spec, LIVE, { env: { PP_REHEARSE_GUARDIAN_KEY: key }, file }, addressOf)).toEqual({ GUARDIAN_KEY: key })
		expect(readKeys(spec, FORK, { env: {}, file, accountHome: scratchHome() }, addressOf)).toEqual({ GUARDIAN_KEY: key })
		const scratch = { PP_TESTNET_SCRATCH_HOME: home }
		expect(readKeys(spec, FORK, { env: scratch, accountHome: scratchHome() }, addressOf)).toEqual({ GUARDIAN_KEY: key })
		expect(() => readKeys(spec, FORK, { env: {}, file, accountHome: home }, addressOf)).toThrow(/scratch key file/)
		expect(() => assertScratchKeyFile(keyFilePath(accountHome()))).toThrow(refusedBy("keys"))
		const refused = (() => {
			try {
				readKeys(spec, REHEARSE, { env: { PP_REHEARSE_GUARDIAN_KEY: key }, file }, addressOf)
			} catch (e) {
				return e as GuardError
			}
		})()
		expect(refused?.message).toMatch(/anvil/)
		expect(refused?.message).not.toContain(key.slice(2))
		const anvil = mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: 3 })
		const anvilKey = `0x${Buffer.from(anvil.getHdKey().privateKey as Uint8Array).toString("hex")}` as Hex
		const unreadable = join(home, "absent", "testnet.env")
		expect(readKeys(spec, REHEARSE, { env: { PP_REHEARSE_GUARDIAN_KEY: anvilKey }, file: unreadable }, addressOf)).toEqual({
			GUARDIAN_KEY: anvilKey,
		})
		expect(redact(`echo ${key} ${key.slice(2).toUpperCase()}`)).toBe("echo [redacted] [redacted]")
	})
})
