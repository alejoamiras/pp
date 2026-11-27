import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { TxHash } from "@aztec-labs/aztec.js/tx"
import { connectL2 } from "@pp/bridge-core/sandbox"
import { type Hex, readRootRecord } from "@pp/label-paths"
import { claimPort, registryPath, releaseRows } from "@pp/run-isolation/ports"
import { describe, expect, it } from "vitest"
import { botSecret } from "../../src/accounts"
import type { StandaloneBotConfig } from "../../src/standalone"
import { approve, deployRegistry } from "./support"

// Run through `bun run test:integration`, which boots the stack and sets PP_STACK_MANIFEST.
const MANIFEST = process.env.PP_STACK_MANIFEST
const RUN = process.env.PP_BOT_INTEGRATION === "1" && MANIFEST !== undefined
const DRIVER = fileURLToPath(new URL("./standalone-driver.ts", import.meta.url))
const READY_TIMEOUT_MS = 840_000

type Manifest = { l1Rpc: string; aztecNode: string; chainId: number; pool: { aspRegistry: Hex; entrypoint: Hex; aspApiUrl: string } }
type Ready = { url: string; post: { sequence: string; txHash: Hex; l2Block: number } }

/** A port free in the host registry and on loopback now, released for the bot to claim itself. */
async function freePort(): Promise<number> {
	const probe = `standalone-probe-${process.pid}`
	const port = await claimPort(probe, "probe")
	await releaseRows(probe)
	return port
}

/** The child's first `ready` line, or a rejection carrying its stderr when it exits or times out first. */
function readyOf(child: ReturnType<typeof spawn>, stderr: string[]): Promise<Ready> {
	return new Promise((ok, fail) => {
		const timer = setTimeout(() => fail(new Error(`no ready line in ${READY_TIMEOUT_MS} ms:\n${stderr.join("")}`)), READY_TIMEOUT_MS)
		createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (text) => {
			const e = JSON.parse(text) as { event: string } & Ready
			if (e.event !== "ready") return
			clearTimeout(timer)
			ok(e)
		})
		child.once("exit", (code) => {
			clearTimeout(timer)
			fail(new Error(`driver exited (${code}) before ready:\n${stderr.join("")}`))
		})
	})
}

const storesOf = (pid: number) => readdirSync("/dev/shm").filter((n) => n.startsWith("pp-aspbot-") && n.includes(`-${pid}-`))

describe.skipIf(!RUN)("the standalone bot against the local stack", () => {
	it("posts with keys given as values, reports its own checkpointed post, and stops on a signal leaving no port row or store", async () => {
		const m = JSON.parse(readFileSync(MANIFEST as string, "utf8")) as Manifest
		const stackRunId = `it-standalone-${process.pid}-${randomBytes(3).toString("hex")}`
		const runId = `${stackRunId}-bot`
		await approve(m.pool.aspApiUrl, 0x5eed11n)
		const l2 = await connectL2(m.aztecNode)
		const registry = await deployRegistry(l2, stackRunId)
		const config: StandaloneBotConfig = {
			deployment: {
				l1Rpc: m.l1Rpc,
				aztecNode: m.aztecNode,
				aspApiUrl: m.pool.aspApiUrl,
				aspRegistry: m.pool.aspRegistry,
				entrypoint: m.pool.entrypoint,
				chainId: m.chainId,
				registry,
				tokens: [],
			},
			runId,
			port: await freePort(),
			inclusionMarginSec: 300,
			postTimeoutSec: 600,
		}
		const stderr: string[] = []
		const child = spawn(process.execPath, [DRIVER], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, PP_STANDALONE_TEST: JSON.stringify({ config, poster: botSecret("poster", stackRunId) }) },
		})
		child.stderr?.on("data", (b: Buffer) => stderr.push(b.toString()))
		const exited = new Promise<number | null>((ok) => child.once("exit", (code) => ok(code)))
		try {
			const ready = await readyOf(child, stderr)
			expect(ready.url).toBe(`http://127.0.0.1:${config.port}`)
			expect(readFileSync(registryPath(), "utf8")).toContain(`| ${config.port} | asp-bot | ${runId} |`)
			const record = await readRootRecord({ aztecNode: m.aztecNode, registry })
			expect(record.sequence).toBe(BigInt(ready.post.sequence))
			const receipt = await l2.node.getTxReceipt(TxHash.fromString(ready.post.txHash))
			expect(Number(receipt.blockNumber)).toBe(ready.post.l2Block)
			expect(Number(await l2.node.getBlockNumber("checkpointed" as never))).toBeGreaterThanOrEqual(ready.post.l2Block)
			expect((await fetch(`${ready.url}/v1/snapshots/latest`)).status).toBe(200)
			expect(storesOf(child.pid as number)).toHaveLength(1)
		} finally {
			child.kill("SIGTERM")
		}
		expect(await exited).toBe(0)
		expect(readFileSync(registryPath(), "utf8")).not.toContain(runId)
		expect(storesOf(child.pid as number)).toEqual([])
	})
})
