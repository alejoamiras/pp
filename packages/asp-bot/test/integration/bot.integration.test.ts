import { randomBytes } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { connectL2 } from "@pp/bridge-core/sandbox"
import { type Hex, parseAspSnapshot, pathFor, readRootRecord } from "@pp/label-paths"
import { createPublicClient, http, parseAbi } from "viem"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type BotHandle, type BotManifest, startBot } from "../../src/index"
import { approve, deployRegistry } from "./support"

// Run through `bun run test:integration`, which boots the stack and sets PP_STACK_MANIFEST.
const MANIFEST = process.env.PP_STACK_MANIFEST
const RUN = process.env.PP_BOT_INTEGRATION === "1" && MANIFEST !== undefined
const LABELS = [0x5eed01n, 0x5eed02n]
const ABI = parseAbi(["function latestASPRoot() view returns (uint256)"])

describe.skipIf(!RUN)("asp-bot against the local stack", () => {
	const stackRunId = `it-${process.pid}-${randomBytes(3).toString("hex")}`
	const runId = `${stackRunId}-bot`
	let manifest: BotManifest
	let registry: Hex
	let bot: BotHandle | undefined

	beforeAll(async () => {
		manifest = JSON.parse(readFileSync(MANIFEST as string, "utf8")) as BotManifest
		for (const label of LABELS) await approve(manifest.pool.aspApiUrl, label)
		registry = await deployRegistry(await connectL2(manifest.aztecNode), stackRunId)
		bot = await startBot({ manifest, registry, tag: "latest", stackRunId, runId, inclusionMarginSec: 60 }, { removeDataOnStop: true })
	})

	afterAll(async () => {
		try {
			await bot?.stop()
		} catch (e) {
			process.exitCode = 1
			throw e
		}
	})

	it("serves the posted snapshot, whose pool root is the L1 root at the posted block", async () => {
		const live = bot as BotHandle
		const res = await fetch(`${live.url}/v1/snapshots/latest`)
		expect(res.headers.get("cache-control")).toBe("no-store")
		const snap = parseAspSnapshot(await res.json())
		const record = await readRootRecord({ aztecNode: manifest.aztecNode, registry })
		expect([snap.sequence, snap.poolRoot, snap.birthRoot]).toEqual([record.sequence, record.poolRoot, record.birthRoot])
		expect(record.sequence).toBe(1n)

		const l1 = createPublicClient({ transport: http(manifest.l1Rpc) })
		const l1Root = await l1.readContract({
			address: manifest.pool.aspRegistry,
			abi: ABI,
			functionName: "latestASPRoot",
			blockNumber: record.l1Block,
		})
		expect(record.poolRoot).toBe(l1Root)
		for (const label of LABELS) expect(pathFor(snap, label, 0)).not.toBeNull()
		expect(pathFor(snap, 0x5eed03n, 0)).toBeNull()
		expect((await fetch(`${live.url}/v1/snapshots/2`)).status).toBe(404)
	})

	it("stop leaves no group member, port row or run directory", async () => {
		const live = bot as BotHandle
		await live.stop()
		expect(() => process.kill(-live.pgid, 0)).toThrow()
		expect(readFileSync(join(homedir(), ".agents", "ports.md"), "utf8")).not.toContain(runId)
		expect(existsSync(join(homedir(), ".cache", "pp", "asp-bot", "runs", runId))).toBe(false)
	})
})
