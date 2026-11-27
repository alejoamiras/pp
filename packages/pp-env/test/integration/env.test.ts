import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { anvilKey, LOG_DIR, USER_INDEX } from "../../src/env/harness/anvil.ts"
import { rowsOwnedBy } from "@pp/run-isolation/ports"
import { rpc } from "../../src/env/harness/rpc.ts"
import { attachForkPoolEnv } from "../../src/env/fork.ts"
import { localClients, type PoolEnv, startPoolEnv } from "../../src/env/index.ts"

const ASSETS_ABI = [
	{
		type: "function",
		name: "assets",
		stateMutability: "view",
		inputs: [{ name: "asset", type: "address" }],
		outputs: [
			{
				name: "config",
				type: "tuple",
				components: [
					{ name: "enabled", type: "bool" },
					{ name: "minAmount", type: "uint256" },
					{ name: "vettingFeeBPS", type: "uint256" },
					{ name: "maxRelayFee", type: "uint256" },
				],
			},
		],
	},
] as const
const ROOT_ABI = [
	{ type: "function", name: "latestASPRoot", stateMutability: "view", inputs: [], outputs: [{ name: "root", type: "uint256" }] },
	{ type: "error", name: "ASPRegistry_EmptyAssociationSet", inputs: [] },
] as const

/** PIDs of anvils this test process spawned; they lead their own groups but keep us as parent. */
function anvilChildren(): number[] {
	const pids: number[] = []
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue
		try {
			const stat = readFileSync(`/proc/${entry}/stat`, "utf8")
			const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"))
			const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])
			if (ppid === process.pid && comm.includes("anvil")) pids.push(Number(entry))
		} catch {}
	}
	return pids
}

const port = (url: string) => new URL(url).port
const alive = (url: string) =>
	rpc<string>(url, "eth_chainId").then(
		() => true,
		() => false,
	)

describe.skipIf(!process.env.PP_ENV_INTEGRATION)("pool env", () => {
	let a: PoolEnv
	let b: PoolEnv

	beforeAll(async () => {
		const t0 = performance.now()
		;[a, b] = await Promise.all([startPoolEnv(), startPoolEnv()])
		console.log(`[pp-env] two parallel envs up in ${Math.round(performance.now() - t0)} ms`)
	})
	afterAll(async () => {
		await Promise.allSettled([a?.stop(), b?.stop()])
	})

	test("deploys the pool, enables the asset, and publishes ASP roots", async () => {
		const { client } = localClients(a.rpcUrl, anvilKey(USER_INDEX))
		const { pool, entrypoint, keystore, aspRegistry } = a.deployment
		for (const address of [pool, entrypoint, keystore, aspRegistry]) expect(await client.getCode({ address })).not.toBe("0x")
		const config = await client.readContract({ address: entrypoint, abi: ASSETS_ABI, functionName: "assets", args: [a.asset] })
		expect(config.enabled).toBe(true)
		const latest = () => client.readContract({ address: aspRegistry, abi: ROOT_ABI, functionName: "latestASPRoot" })
		await expect(latest()).rejects.toThrow(/ASPRegistry_EmptyAssociationSet/)
		const first = await a.asp.approveLabel(123n)
		expect(await latest()).toBe(first)
		const second = await a.asp.approveLabel(456n)
		expect(second).not.toBe(first)
		expect(await latest()).toBe(second)
	})

	test("parallel envs claim distinct registered ports", () => {
		expect(new Set([a.rpcUrl, a.asp.url, b.rpcUrl, b.asp.url].map(port)).size).toBe(4)
		expect(rowsOwnedBy(a.runId)).toBe(2)
		expect(rowsOwnedBy(b.runId)).toBe(2)
	})

	test("a run ID already in use is refused, and the live env keeps its ports", async () => {
		await expect(startPoolEnv({ runId: b.runId })).rejects.toThrow(/in use/)
		expect(rowsOwnedBy(b.runId)).toBe(2)
	})

	test("a failed start releases its ports and kills its anvil, leaving other envs up", async () => {
		const runId = `pp-env-fail-${process.pid}`
		// Index 40 is past anvil's 16 funded accounts, so the deploy broadcast fails after anvil is up.
		await expect(startPoolEnv({ runId, deployerIndex: 40 })).rejects.toThrow()
		expect(existsSync(join(LOG_DIR, `${runId}-anvil.log`))).toBe(true)
		expect(rowsOwnedBy(runId)).toBe(0)
		expect(anvilChildren()).toHaveLength(2)
		expect(await alive(a.rpcUrl)).toBe(true)
	})

	test("attach deploys a second pool on a foreign anvil and leaves it running", async () => {
		const c = await startPoolEnv({ rpcUrl: b.rpcUrl })
		expect(c.deployment.pool).not.toBe(b.deployment.pool)
		await c.stop()
		expect(rowsOwnedBy(c.runId)).toBe(0)
		expect(await alive(b.rpcUrl)).toBe(true)
	})

	test("attach refuses a non-loopback RPC", async () => {
		await expect(startPoolEnv({ rpcUrl: "http://10.255.255.1:8545" })).rejects.toThrow(/non-loopback/)
	})

	test("the fork attach publishes as the impersonated postman, and its stop frees only its own row", async () => {
		const runId = `pp-env-fork-${process.pid}`
		const { pool, entrypoint, keystore, aspRegistry, deployBlock, postman } = b.deployment
		const base = { rpcUrl: b.rpcUrl, chainId: b.chainId, postman, circuitsDir: b.clientConfig.circuitsDir, runId }
		const options = { ...base, deployment: { pool, entrypoint, keystore, aspRegistry, deployBlock } }
		const clientVersion = await rpc<string>(b.rpcUrl, "web3_clientVersion")
		await expect(attachForkPoolEnv({ ...options, clientVersion: `${clientVersion}-other` })).rejects.toThrow(/expected exactly/)
		expect(rowsOwnedBy(`${runId}-pool`)).toBe(0)
		const fork = await attachForkPoolEnv({ ...options, clientVersion })
		const { client } = localClients(b.rpcUrl, anvilKey(USER_INDEX))
		const root = await fork.asp.approveLabel(789n)
		expect(await client.readContract({ address: aspRegistry, abi: ROOT_ABI, functionName: "latestASPRoot" })).toBe(root)
		expect(fork.clientConfig.aspUrl).toBe(fork.asp.url)
		await Promise.all([fork.stop(), fork.stop()])
		expect(rowsOwnedBy(`${runId}-pool`)).toBe(0)
		expect(rowsOwnedBy(b.runId)).toBe(2)
		expect(await alive(b.rpcUrl)).toBe(true)
	})

	test("stop is idempotent and frees the run's ports and processes", async () => {
		await a.stop()
		await a.stop()
		expect(rowsOwnedBy(a.runId)).toBe(0)
		expect(await alive(a.rpcUrl)).toBe(false)
		expect(
			await fetch(a.asp.url).then(
				() => true,
				() => false,
			),
		).toBe(false)
		expect(anvilChildren()).toHaveLength(1)
	})
})
