import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { anvilKey, LOG_DIR, USER_INDEX } from "../../src/env/harness/anvil.ts"
import { claimPort, registryPath, releasePorts, rowsOwnedBy } from "@pp/run-isolation/ports"
import { getAddress, keccak256, parseAbiItem, toHex } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
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
const GRANT_ROLE_ABI = [
	{
		type: "function",
		name: "grantRole",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "role", type: "bytes32" },
			{ name: "account", type: "address" },
		],
		outputs: [],
	},
] as const
const ROOT_UPDATED = parseAbiItem("event ASPRootUpdated(uint256 indexed _root, bytes _ipfsCID)")
const ROOT_ABI = [
	{ type: "function", name: "latestASPRoot", stateMutability: "view", inputs: [], outputs: [{ name: "root", type: "uint256" }] },
	{ type: "error", name: "ASPRegistry_EmptyAssociationSet", inputs: [] },
] as const

/** Groups this test process spawned that still run an anvil: each is led by our child, the launcher, with anvil under it. */
function anvilGroups(): number[] {
	const procs: { pid: number; ppid: number; pgrp: number; running: boolean; comm: string }[] = []
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue
		try {
			const stat = readFileSync(`/proc/${entry}/stat`, "utf8")
			const [state, ppid, pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
			const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"))
			procs.push({ pid: Number(entry), ppid: Number(ppid), pgrp: Number(pgrp), running: state !== "Z", comm })
		} catch {}
	}
	const leaders = new Set(procs.filter((p) => p.ppid === process.pid).map((p) => p.pid))
	return [...new Set(procs.filter((p) => p.running && p.comm.includes("anvil") && leaders.has(p.pgrp)).map((p) => p.pgrp))]
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
		expect(anvilGroups()).toHaveLength(2)
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

	test("the fork attach publishes as an impersonated postman with no key, and its stop frees only its own row", async () => {
		const { pool, entrypoint, keystore, aspRegistry, deployBlock, accessRouter } = b.deployment
		// A postman no local key controls, so only anvil's impersonation can publish as it.
		const postman = privateKeyToAccount(generatePrivateKey()).address
		const admin = localClients(b.rpcUrl, anvilKey(b.deployerIndex))
		const grant = await admin.wallet.writeContract({
			address: accessRouter,
			abi: GRANT_ROLE_ABI,
			functionName: "grantRole",
			args: [keccak256(toHex("POSTMAN_ROLE")), postman],
		})
		expect((await admin.client.waitForTransactionReceipt({ hash: grant })).status).toBe("success")
		const clientVersion = await rpc<string>(b.rpcUrl, "web3_clientVersion")
		const options = {
			rpcUrl: b.rpcUrl,
			chainId: b.chainId,
			postman,
			circuitsDir: b.clientConfig.circuitsDir,
			deployment: { pool, entrypoint, keystore, aspRegistry, deployBlock },
			clientVersion,
			runId: b.runId,
		}
		await expect(attachForkPoolEnv({ ...options, clientVersion: `${clientVersion}-other` })).rejects.toThrow(/expected exactly/)
		await expect(attachForkPoolEnv({ ...options, runId: a.runId })).rejects.toThrow(`registered to ${b.runId}, not ${a.runId}`)
		expect(rowsOwnedBy(`${b.runId}:pool`)).toBe(0)
		// local-stack starts pp-env as `<id>-pool`: an attach whose run id is that stack's must not share its owner.
		const stackRun = `${b.runId}-pool`
		await claimPort(stackRun, "stack-pool")
		let fork: Awaited<ReturnType<typeof attachForkPoolEnv>>
		try {
			const attaches = await Promise.allSettled([attachForkPoolEnv(options), attachForkPoolEnv(options)])
			const won = attaches.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []))
			const lost = attaches.flatMap((r) => (r.status === "rejected" ? [r.reason as Error] : []))
			const winner = won[0]
			if (won.length !== 1 || !winner) {
				await Promise.all(won.map((f) => f.stop()))
				throw new Error(`expected exactly one of two concurrent attaches to win, got ${won.length}`)
			}
			fork = winner
			try {
				expect(lost.map((e) => e.message)).toEqual([
					`run ${b.runId} already has a fork attach: ${registryPath()} lists a row owned by ${b.runId}:pool. Stop that attach, or remove the row by hand if no attach is running`,
				])
				expect(rowsOwnedBy(`${b.runId}:pool`)).toBe(1)
				const root = await fork.asp.approveLabel(789n)
				expect(await admin.client.readContract({ address: aspRegistry, abi: ROOT_ABI, functionName: "latestASPRoot" })).toBe(root)
				// The deployer is a postman too, so only the update's sender shows the impersonation published it.
				const [update] = await admin.client.getLogs({
					address: aspRegistry,
					event: ROOT_UPDATED,
					args: { _root: root },
					fromBlock: 0n,
				})
				if (!update) throw new Error("no ASPRootUpdated for the approved root")
				expect(getAddress((await admin.client.getTransaction({ hash: update.transactionHash })).from)).toBe(postman)
				expect(fork.clientConfig.aspUrl).toBe(fork.asp.url)
			} finally {
				await Promise.all([fork.stop(), fork.stop()])
			}
			await expect(fork.asp.approveLabel(790n)).rejects.toThrow("stopped")
			expect(rowsOwnedBy(`${b.runId}:pool`)).toBe(0)
			expect(rowsOwnedBy(stackRun)).toBe(1)
		} finally {
			await releasePorts(stackRun)
		}
		expect(rowsOwnedBy(b.runId)).toBe(2)
		expect(
			await fetch(fork.asp.url).then(
				() => true,
				() => false,
			),
		).toBe(false)
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
		expect(anvilGroups()).toHaveLength(1)
	})
})
