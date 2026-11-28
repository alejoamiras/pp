import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest"
import { type ChildProcess, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseStackManifest } from "@pp/bridge-core"
import { type Hex, parseAspSnapshot, readRootRecord } from "@pp/label-paths"
import { type PoolEnv, startPoolEnv } from "@pp/pp-env"
import { createPublicClient, http, type PublicClient } from "viem"
import { AttachRefused } from "../../src/attach.ts"
import { nodeInfo } from "../../src/node-rpc.ts"
import { newRunId } from "../../src/run-dir.ts"
import { startStack } from "../../src/stack.ts"
import { lookAtGroups, portsOwnedBy, processTree, registryRows, residueOf, sampleTree } from "./residue.ts"

const REPO = join(import.meta.dirname, "..", "..", "..", "..")
const BOOT_MS = 600_000
type Run = ReturnType<typeof launch>
type Reapable = { child: ChildProcess; tree: { ownedAlive(): number[]; unverifiedAlive(): number[] }; stopSampling(): void }
/** Every CLI this file starts, so a failed assertion cannot leave one running. */
const launched: Reapable[] = []

/**
 * Best-effort reap of a run a failed test left up: SIGINT, then, after 90 s or once the CLI is gone,
 * SIGKILL to each surviving group whose leader is verified, since the harnesses' children run in
 * groups of their own and can outlive the CLI.
 */
async function reap(run: Reapable): Promise<void> {
	const kill = () => {
		for (const g of run.tree.ownedAlive()) {
			try {
				process.kill(-g, "SIGKILL")
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err
			}
		}
	}
	const { child } = run
	if (child.exitCode === null && child.signalCode === null) {
		const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()))
		child.kill("SIGINT")
		const timer = setTimeout(kill, 90_000)
		await gone
		clearTimeout(timer)
	}
	run.stopSampling()
	kill()
	for (const g of await lookAtGroups(run.tree.unverifiedAlive()).settle())
		console.warn(`[reap] left group ${g} alone: its leader is not the process sampled`)
}

/** One CLI run in its own process group, with its output, its sampled tree and the ports it claimed. */
function launch(cmd: string[], ignorePgids: ReadonlySet<number>, env: Record<string, string | undefined> = process.env) {
	const child: ChildProcess = spawn(cmd[0] as string, cmd.slice(1), { cwd: REPO, detached: true, stdio: ["ignore", "pipe", "pipe"], env })
	const lines: string[] = []
	const onData = (chunk: Buffer) => lines.push(...chunk.toString().split("\n").filter(Boolean))
	child.stdout?.on("data", onData)
	child.stderr?.on("data", onData)
	const exit = new Promise<number | null>((resolve) => child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 : null))))
	const tree = sampleTree(child.pid as number, ignorePgids)
	const ports = new Set<number>()
	const runId = () => lines.map((l) => l.match(/^\[stack\] run (\S+) pid \d+$/)?.[1]).find(Boolean)
	const portTimer = setInterval(() => {
		const id = runId()
		if (id) for (const p of portsOwnedBy(id)) ports.add(p)
	}, 250)
	const waitFor = async (re: RegExp, ms = BOOT_MS) => {
		const deadline = Date.now() + ms
		for (;;) {
			const hit = lines.find((l) => re.test(l))
			if (hit) return hit
			if (Date.now() > deadline)
				throw new Error(`no line matching ${re} within ${ms} ms; last lines:\n${lines.slice(-15).join("\n")}`)
			await Bun.sleep(100)
		}
	}
	const stopSampling = () => {
		tree.stop()
		clearInterval(portTimer)
	}
	const finished = async () => {
		const code = await exit
		stopSampling()
		return code
	}
	const tmpDir = () => lines.map((l) => l.match(/, tmp (\S+)$/)?.[1]).find(Boolean)
	const run = { child, lines, waitFor, finished, stopSampling, tree, ports, runId, tmpDir }
	launched.push(run)
	return run
}

describe.skipIf(!process.env.PP_STACK_INTEGRATION)("a stack tears down exactly what it started", () => {
	let sibling: PoolEnv
	let siblingClient: PublicClient
	let siblingPgids: Set<number>
	const siblingChain = async () => ({
		block: await siblingClient.getBlockNumber({ cacheTime: 0 }),
		poolCode: await siblingClient.getCode({ address: sibling.deployment.pool }),
	})
	const expectSiblingIntact = async () => {
		expect(await siblingClient.getChainId()).toBe(31337)
		expect(registryRows().some((r) => r.owner === sibling.runId)).toBe(true)
	}
	/** Every CLI case gets past the network, so it must have been seen with ports and a TMPDIR. */
	const expectClean = async (run: Run) => {
		const [runId, tmpDir] = [run.runId(), run.tmpDir()]
		expect(runId).toBeTruthy()
		expect(tmpDir).toBeTruthy()
		expect(run.ports.size).toBeGreaterThan(0)
		expect(await residueOf({ runId: runId as string, pgids: run.tree.pgids, ports: run.ports, tmpDir })).toEqual([])
		await expectSiblingIntact()
	}

	beforeAll(async () => {
		sibling = await startPoolEnv({ signals: false })
		siblingClient = createPublicClient({ transport: http(sibling.rpcUrl) })
		siblingPgids = new Set(processTree(process.pid).map((p) => p.pgid))
	}, BOOT_MS)

	afterEach(async () => {
		await Promise.all(launched.splice(0).map(reap))
	}, 120_000)

	afterAll(async () => {
		await sibling?.stop()
	})

	test("clean: without --keep it boots, prints the ready line, and exits 0", async () => {
		const run = launch(["bun", "packages/local-stack/src/cli.ts", "demo"], siblingPgids)
		await run.waitFor(/^\[stack\] ready in [\d.]+ s — PP_STACK_MANIFEST=/)
		expect(await run.finished()).toBe(0)
		await expectClean(run)
	})

	test("kept: `bun run demo --keep` serves a live manifest until SIGINT, then exits 130", async () => {
		const run = launch(["bun", "run", "demo", "--keep"], siblingPgids)
		const ready = await run.waitFor(/PP_STACK_MANIFEST=/)
		const path = ready.split("PP_STACK_MANIFEST=")[1] as string
		const m = parseStackManifest(JSON.parse(readFileSync(path, "utf8")))
		const client = createPublicClient({ transport: http(m.l1Rpc) })
		expect(await client.getChainId()).toBe(31337)
		for (const address of [m.pool.poolVault, m.pool.entrypoint, m.pool.aspRegistry, m.pool.keystore, m.pool.asset])
			expect(await client.getCode({ address })).toBeTruthy()
		expect((await fetch(new URL("/health", m.pool.aspApiUrl))).ok).toBe(true)
		expect((await nodeInfo(m.aztecNode)).l1ChainId).toBe(31337)
		const [bot, bridge] = [m.bot, m.bridge]
		if (!bot || !bridge) throw new Error("the manifest has no bot or bridge block")
		const snap = parseAspSnapshot(await (await fetch(new URL("/v1/snapshots/latest", bot.url))).json())
		const record = await readRootRecord({ aztecNode: m.aztecNode, registry: bridge.registry as Hex })
		expect(record.sequence).toBeGreaterThan(0n)
		expect([snap.sequence, snap.poolRoot, snap.birthRoot]).toEqual([record.sequence, record.poolRoot, record.birthRoot])
		const cliPid = Number(run.lines.find((l) => l.startsWith("[stack] run "))?.match(/pid (\d+)$/)?.[1])
		expect(Number(readFileSync(join(path, "..", "pid"), "utf8"))).toBe(cliPid)
		const t0 = Date.now()
		run.child.kill("SIGINT")
		expect(await run.finished()).toBe(130)
		expect(Date.now() - t0).toBeLessThan(90_000)
		await expectClean(run)
	})

	test("boot signal: SIGINT while pp-env runs forge stops the boot and exits 130", async () => {
		const run = launch(["bun", "packages/local-stack/src/cli.ts", "demo"], siblingPgids)
		// The network's harness runs a forge of its own; only one alive after this line is pp-env's.
		await run.waitFor(/^\[stack\] pool starting on /)
		const deadline = Date.now() + BOOT_MS
		while (!processTree(run.child.pid as number).some((p) => /\bforge\b/.test(p.args))) {
			if (Date.now() > deadline) throw new Error("never saw pp-env's forge child")
			await Bun.sleep(200)
		}
		run.child.kill("SIGINT")
		expect(await run.finished()).toBe(130)
		expect(run.lines.some((l) => l.includes("stopping once the current step returns"))).toBe(true)
		await expectClean(run)
	})

	test("failed: a step that throws after the pool unwinds everything", async () => {
		const runId = newRunId()
		const tree = sampleTree(process.pid, new Set(processTree(process.pid).map((p) => p.pgid)))
		const ports = new Set<number>()
		const portTimer = setInterval(() => {
			for (const p of portsOwnedBy(runId)) ports.add(p)
		}, 250)
		try {
			await expect(
				startStack({
					runId,
					onStep: ({ step }) => {
						if (step === "pool") throw new Error("injected after the pool")
					},
				}),
			).rejects.toThrow("injected after the pool")
		} finally {
			tree.stop()
			clearInterval(portTimer)
		}
		expect(ports.size).toBeGreaterThan(0)
		expect(await residueOf({ runId, pgids: tree.pgids, ports })).toEqual([])
		await expectSiblingIntact()
	})

	test("refused: set attach variables stop the CLI and startStack before they touch any chain", async () => {
		const before = await siblingChain()
		const env = { ...process.env, SANDBOX_L1_RPC: sibling.rpcUrl, SANDBOX_NODE_URL: sibling.rpcUrl }
		const run = launch(["bun", "packages/local-stack/src/cli.ts", "demo"], siblingPgids, env)
		expect(await run.finished()).toBe(2)
		expect(run.lines.join("\n")).toContain("unset SANDBOX_L1_RPC SANDBOX_NODE_URL")
		process.env.SANDBOX_L1_RPC = sibling.rpcUrl
		process.env.SANDBOX_NODE_URL = sibling.rpcUrl
		try {
			await expect(startStack()).rejects.toBeInstanceOf(AttachRefused)
		} finally {
			delete process.env.SANDBOX_L1_RPC
			delete process.env.SANDBOX_NODE_URL
		}
		expect(await siblingChain()).toEqual(before)
		await expectSiblingIntact()
	})
})
