import { spawn } from "node:child_process"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { ANVIL_CLIENT_VERSION } from "@pp/sepolia-fork/anvil"
import { encodeAbiParameters, maxUint256, toFunctionSelector } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest"
import { FEE_FLOOR_WEI, needOf } from "./funding"
import { isKeyValue, KEY_NAMES, keyFilePath } from "./keyfile"
import { loopback } from "./network"
import { configuredTarget } from "./schema"
import { scratchHome, writeKeyFile } from "./test-support"

const CLI = fileURLToPath(new URL("./cli/", import.meta.url))
const OWN = JSON.parse(readFileSync(fileURLToPath(new URL("../deployments/testnet-own.json", import.meta.url)), "utf8"))

type Run = { code: number | null; out: string }

/** Runs a CLI under `home` with stdin closed; async, so this process keeps serving the fake L1. */
const cli = (name: string, args: string[], home: string, extra: Record<string, string> = {}): Promise<Run> =>
	script(join(CLI, `${name}.ts`), args, home, extra)

function script(path: string, args: string[], home: string, extra: Record<string, string> = {}): Promise<Run> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [path, ...args], {
			env: { PATH: process.env.PATH, HOME: home, ...extra },
			stdio: ["ignore", "pipe", "pipe"],
		})
		let out = ""
		child.stdout.on("data", (b) => (out += b))
		child.stderr.on("data", (b) => (out += b))
		child.on("error", reject)
		child.on("close", (code) => resolve({ code, out }))
	})
}

const leaks = (out: string, values: readonly string[]) =>
	values.filter((v) => out.toLowerCase().includes(v.toLowerCase().replace(/^0x/, "")))

// A loopback L1 that answers what the guards and `fund` read before a key is used, and the entrypoint's
// asset config at a vetting fee of 1.5%; anything else errors. `seen` records every method asked.
let server: Server
let rpc: string
// An answer is a value, or a function of the call's params.
const answers: Record<string, unknown> = {}
const seen: string[] = []
const ASSETS = toFunctionSelector("assets(address)")
const ASSET_CONFIG = encodeAbiParameters(
	[{ type: "bool" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
	[true, 1n, 150n, maxUint256],
)
beforeAll(async () => {
	Object.assign(answers, {
		web3_clientVersion: ANVIL_CLIENT_VERSION,
		eth_chainId: "0xaa36a7",
		eth_blockNumber: "0x10",
		eth_getBalance: "0x56bc75e2d63100000",
		eth_getTransactionCount: "0x0",
		eth_estimateGas: "0x5208",
		eth_maxPriorityFeePerGas: "0x3b9aca00",
		eth_gasPrice: "0x77359400",
		eth_getBlockByNumber: {
			number: "0x10",
			hash: `0x${"1".repeat(64)}`,
			timestamp: "0x1",
			baseFeePerGas: "0x3b9aca00",
			transactions: [],
		},
	})
	server = createServer((req, res) => {
		let body = ""
		req.on("data", (b) => (body += b))
		req.on("end", () => {
			const { id, method, params } = JSON.parse(body) as { id: number; method: string; params?: [{ data?: string }] }
			seen.push(method)
			const answer = answers[method]
			const result =
				method === "eth_call" && params?.[0].data?.startsWith(ASSETS)
					? ASSET_CONFIG
					: typeof answer === "function"
						? (answer as (p: unknown) => unknown)(params)
						: answer
			res.setHeader("content-type", "application/json")
			res.end(
				JSON.stringify(
					result === undefined ? { jsonrpc: "2.0", id, error: { code: -32601, message: "no" } } : { jsonrpc: "2.0", id, result },
				),
			)
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	rpc = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`
const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}`

/** The own target on the fake L1, with every section a key-reading CLI requires and addresses no sentinel key owns. */
function deploymentFile(home: string, sections: { pool: boolean }, expected: Record<string, string | undefined> = {}): string {
	const d = {
		...configuredTarget(OWN),
		network: { ...OWN.network, l1Rpc: rpc, l1SendRpc: rpc },
		expected: {
			guardian: addr(1),
			lifetimeCap: "1000",
			l1Deployer: addr(2),
			l2Deployer: word(3),
			botPoster: word(4),
			aspPostman: addr(5),
			poolDeployer: addr(6),
			canaryOwner: addr(7),
			canarySender: addr(8),
			demoOwner: addr(24),
			demoSender: addr(25),
			birthIntake: word(9),
			tokenClassId: word(10),
			amounts: { debit: "100", note: "100", bridge: "50" },
			...expected,
		},
		...(sections.pool && {
			pool: {
				poolVault: addr(11),
				entrypoint: addr(12),
				aspRegistry: addr(13),
				keystore: addr(14),
				asset: addr(15),
				deployBlock: "1",
				aspApiUrl: loopback(OWN.network.aspPort),
				accessRouter: addr(16),
				relay: addr(17),
			},
			bridge: {
				factory: addr(18),
				portal: addr(19),
				hub: word(20),
				token: word(21),
				registry: word(22),
				deployBlock: "2",
				factoryTx: word(23),
			},
		}),
	}
	const path = join(home, sections.pool ? "full.json" : "bare.json")
	writeFileSync(path, JSON.stringify(d))
	return path
}

const sentinels = () => KEY_NAMES.map((k) => [k.name, k.kind === "l1" ? generatePrivateKey() : Fr.random().toString()] as const)

describe("keys", () => {
	it("creates the file 0700/0600, prints addresses only, never rewrites a name, and refuses a looser directory", async () => {
		const home = scratchHome()
		const first = await cli("keys", [], home)
		expect(first.code).toBe(0)
		const path = keyFilePath(home)
		expect([statSync(dirname(path)).mode & 0o777, statSync(path).mode & 0o777]).toEqual([0o700, 0o600])
		const lines = readFileSync(path, "utf8").trim().split("\n")
		const values = lines.map((l) => l.slice(l.indexOf("=") + 1))
		expect(lines.map((l) => l.slice(0, l.indexOf("=")))).toEqual(KEY_NAMES.map((k) => k.name))
		expect(KEY_NAMES.filter((k, i) => !isKeyValue(k.kind, values[i] as string)).map((k) => k.name)).toEqual([])
		expect(leaks(first.out, values)).toEqual([])
		const events = first.out
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l))
		expect(events.map((e) => [e.name, e.created])).toEqual(KEY_NAMES.map((k) => [k.name, true]))

		// A file from before the demo accounts gains them at its end, every earlier line untouched.
		const older = lines.filter((l) => !l.startsWith("DEMO_"))
		writeFileSync(path, `${older.join("\n")}\n`)
		const second = await cli("keys", [], home)
		expect(second.code).toBe(0)
		const after = readFileSync(path, "utf8").trim().split("\n")
		expect(after.slice(0, -2)).toEqual(older)
		expect(after.slice(-2).map((l) => l.slice(0, l.indexOf("=")))).toEqual(["DEMO_OWNER_KEY", "DEMO_SENDER_KEY"])
		expect(
			leaks(
				second.out,
				after.map((l) => l.slice(l.indexOf("=") + 1)),
			),
		).toEqual([])
		expect(second.out.split("\n").filter((l) => l.includes('"created":true'))).toHaveLength(2)

		chmodSync(dirname(path), 0o750)
		const loose = await cli("keys", [], home)
		expect([loose.code, loose.out]).toEqual([2, expect.stringMatching(/mode 750/)])
	}, 60_000)

	it("refuses to run while SEED makes Aztec's randomness predictable, creating nothing", async () => {
		const home = scratchHome()
		const seeded = await cli("keys", [], home, { SEED: "seed-value-31337" })
		expect([seeded.code, /refused: env: SEED is set/.test(seeded.out), seeded.out.includes("31337")]).toEqual([2, true, false])
		expect(existsSync(dirname(keyFilePath(home)))).toBe(false)
	}, 60_000)

	it("the pins script refuses to run while SEED is set", async () => {
		const pins = fileURLToPath(new URL("../scripts/pins.ts", import.meta.url))
		const seeded = await script(pins, ["--check"], scratchHome(), { SEED: "seed-value-31337" })
		expect([seeded.code, /env: SEED is set/.test(seeded.out), seeded.out.includes("31337")]).toEqual([1, true, false])
	}, 60_000)
})

describe("every key-reading CLI on a fork", () => {
	const RUNS = (bare: string, full: string): [string, string[]][] => [
		["fund", [full]],
		["deploy-pool", [bare]],
		["asp", [full, "--owner", addr(7)]],
		["asp", [full, "--owner", addr(7), "--owner", addr(24)]],
		["seed", [full]],
		["seed", [full, "--demo"]],
		["pause", [full, "--factory", addr(18)]],
		["addresses", [full]],
	]

	const runAll = (home: string) =>
		Promise.all(
			RUNS(deploymentFile(home, { pool: false }), deploymentFile(home, { pool: true })).map(
				async ([name, args]) => [name, await cli(name, [...args, "--rehearse-fork", rpc], home)] as const,
			),
		)

	it("prints no key value when the keys belong to other accounts", async () => {
		const home = scratchHome()
		const keys = sentinels()
		writeKeyFile(
			home,
			keys.map(([n, v]) => `${n}=${v}`),
		)
		const values = keys.map(([, v]) => v)
		const results = await runAll(home)
		for (const [name, r] of results) {
			const refusal = name === "addresses" ? r.code === 0 : r.code === 2 && /refused: account: /.test(r.out)
			expect([name, refusal, leaks(r.out, values)]).toEqual([name, true, []])
		}
		// Both file owners pass the owner check, so the refusal is the postman key's.
		expect(results.filter(([name]) => name === "asp").map(([, r]) => /the postman key is for/.test(r.out))).toEqual([true, true])
	}, 60_000)

	it("prints no value of a malformed key file, refusing each run by the variable's name", async () => {
		const home = scratchHome()
		const garbage = KEY_NAMES.map((k, i) => [k.name, `SENTINEL-${i}-NOT-A-KEY`] as const)
		writeKeyFile(
			home,
			garbage.map(([n, v]) => `${n}=${v}`),
		)
		for (const [name, r] of await runAll(home))
			expect([name, r.code, r.out.includes("SENTINEL"), /refused: keys: \S+ in .* is not a valid/.test(r.out)]).toEqual([
				name,
				2,
				false,
				true,
			])
	}, 60_000)

	it("refuses an L1 that is not the pinned anvil before opening the key file", async () => {
		const home = scratchHome()
		const [bare, full] = [deploymentFile(home, { pool: false }), deploymentFile(home, { pool: true })]
		answers.web3_clientVersion = "Geth/v1.14.0"
		onTestFinished(() => {
			answers.web3_clientVersion = ANVIL_CLIENT_VERSION
		})
		const runs: [string, string[]][] = [
			["fund", [bare]],
			["deploy-pool", [bare]],
			["asp", [full, "--owner", addr(7)]],
			["seed", [full]],
			["verify-deployment", [full, "--pool-only"]],
			["pause", [full, "--factory", addr(18)]],
		]
		const results = await Promise.all(
			runs.map(async ([name, args]) => [name, await cli(name, [...args, "--rehearse-fork", rpc], home)]),
		)
		for (const [name, r] of results as [string, Run][])
			expect([name, r.code, /refused: fork: .*Geth/.test(r.out)]).toEqual([name, 2, true])
	}, 60_000)

	it("fund refuses a plan whose snapshot block misses a top-up that landed after it, before reading a key", async () => {
		const home = scratchHome()
		answers.eth_getTransactionCount = (p: unknown) => ((p as unknown[])[1] === "pending" ? "0x1" : "0x0")
		onTestFinished(() => {
			answers.eth_getTransactionCount = "0x0"
		})
		const r = await cli("fund", [deploymentFile(home, { pool: false }), "--rehearse-fork", rpc], home)
		expect([r.code, /refused: funds: .* at block 16 but 1 pending .*run again/.test(r.out), /keys/.test(r.out)]).toEqual([
			2,
			true,
			false,
		])
	}, 60_000)

	it("deploy-pool refuses caps its balance from a fund at the floor does not cover, past its key's checks and before any send", async () => {
		const home = scratchHome()
		answers.eth_getBalance = `0x${needOf("poolDeployer", FEE_FLOOR_WEI).toString(16)}`
		onTestFinished(() => {
			answers.eth_getBalance = "0x56bc75e2d63100000"
		})
		const key = generatePrivateKey()
		writeKeyFile(
			home,
			sentinels().map(([n, v]) => `${n}=${n === "POOL_DEPLOYER_KEY" ? key : v}`),
		)
		const file = deploymentFile(home, { pool: false }, { poolDeployer: privateKeyToAccount(key).address })
		seen.length = 0
		// The fake L1's base fee and tip are 1 gwei each, so viem estimates 2.2 gwei.
		const r = await cli("deploy-pool", [file, "--rehearse-fork", rpc], home)
		expect([r.code, /refused: fees: .* under the .* ETH .* fee estimate of 2.2 gwei; .*wait/.test(r.out), leaks(r.out, [key])]).toEqual(
			[2, true, []],
		)
		expect(seen).not.toContain("eth_sendRawTransaction")
	}, 60_000)

	it("fund --quote reads no key: it answers with no key file at all", async () => {
		const home = scratchHome()
		const r = await cli("fund", [deploymentFile(home, { pool: false }), "--quote", "--rehearse-fork", rpc], home)
		expect(r.code).toBe(0)
		const events = r.out
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as Record<string, unknown>)
		expect(events.at(-1)).toMatchObject({ event: "funding-quote", deployer: addr(2), short: "0" })
		expect(events.filter((e) => e.event === "funding-need").map((e) => e.roles)).toContain("guardian")
	}, 60_000)
})

describe("seed", () => {
	it("refuses amounts the asset config would not debit before it signs or sends anything, with --recipient and --demo too", async () => {
		const home = scratchHome()
		const [key, demoKey] = [generatePrivateKey(), generatePrivateKey()]
		const own: Record<string, string> = { CANARY_OWNER_KEY: key, DEMO_OWNER_KEY: demoKey }
		writeKeyFile(
			home,
			sentinels().map(([n, v]) => `${n}=${own[n] ?? v}`),
		)
		const derived = { canaryOwner: privateKeyToAccount(key).address, demoOwner: privateKeyToAccount(demoKey).address }
		const file = deploymentFile(home, { pool: true }, derived)
		seen.length = 0
		const runs = await Promise.all(
			[[], ["--recipient", addr(30)], ["--demo"]].map((extra) => cli("seed", [file, ...extra, "--rehearse-fork", rpc], home)),
		)
		for (const r of runs)
			expect([
				r.code,
				/failed: deposit amounts: a note of 100 debits 101 at 150 bps/.test(r.out),
				leaks(r.out, [key, demoKey]),
			]).toEqual([1, true, []])
		expect([seen.includes("eth_call"), seen.filter((m) => m.startsWith("eth_send"))]).toEqual([true, []])
	}, 60_000)
})

describe("the demo accounts", () => {
	it("seed --demo and asp refuse what the file does not commit, printing no key value", async () => {
		const key = generatePrivateKey()
		const keys = sentinels().map(([n, v]) => [n, n === "CANARY_OWNER_KEY" ? key : v] as const)
		const canaryOwner = privateKeyToAccount(key).address
		// One home per case: each writes its own variant of the deployment file.
		const run = (name: string, args: string[], expected: Record<string, string | undefined>) => {
			const home = scratchHome()
			writeKeyFile(
				home,
				keys.map(([n, v]) => `${n}=${v}`),
			)
			return cli(name, [deploymentFile(home, { pool: true }, { canaryOwner, ...expected }), ...args, "--rehearse-fork", rpc], home)
		}
		const cases: [Promise<Run>, RegExp][] = [
			[
				run("seed", ["--demo", "--recipient", addr(30)], {}),
				/refused: argv: --no-register, --recipient and --demo exclude each other/,
			],
			[run("seed", ["--demo"], { demoOwner: undefined }), /refused: file: --demo needs expected.demoOwner/],
			[run("seed", ["--demo"], { demoOwner: canaryOwner }), /refused: file: expected.demoOwner is the canary owner/],
			[run("seed", ["--demo"], {}), /refused: account: the demo owner key is for 0x\w+, the file expects/],
			[run("asp", ["--owner", canaryOwner, "--owner", addr(31)], {}), /refused: account: --owner 0x0+1f is neither/],
		]
		for (const [r, refusal] of await Promise.all(cases.map(async ([p, re]) => [await p, re] as const)))
			expect([
				r.code,
				refusal.test(r.out),
				leaks(
					r.out,
					keys.map(([, v]) => v),
				),
			]).toEqual([2, true, []])
	}, 60_000)
})
