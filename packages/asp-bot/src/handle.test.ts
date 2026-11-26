import { existsSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { type BotConfig, startBot } from "./handle"

const FAKE = fileURLToPath(new URL("../test/fake-child.ts", import.meta.url))
const runIds: string[] = []

function config(tag: string): BotConfig {
	const runId = `asp-bot-unit-${process.pid}-${tag}`
	runIds.push(runId)
	return {
		manifest: {
			l1Rpc: "http://127.0.0.1:1",
			aztecNode: "http://127.0.0.1:2",
			pool: { aspRegistry: "0x01", aspApiUrl: "http://127.0.0.1:3" },
		},
		registry: "0x02",
		tag: "latest",
		stackRunId: "stack",
		runId,
		dataDir: join(homedir(), ".cache", "pp", "asp-bot", "unit", runId),
		inclusionMarginSec: 144,
	}
}

const groupAlive = (pgid: number) => {
	try {
		process.kill(-pgid, 0)
		return true
	} catch {
		return false
	}
}

afterAll(() => {
	for (const id of runIds) rmSync(join(homedir(), ".cache", "pp", "asp-bot", "logs", `${id}.log`), { force: true })
})

describe("startBot", () => {
	it("resolves on ready, answers post-now both ways, and stops the whole group", async () => {
		const c = config("ok")
		const released: string[] = []
		const bot = await startBot(c, {
			command: [process.execPath, FAKE, "stubborn"],
			killAfterMs: 300,
			removeDataOnStop: true,
			releasePorts: async (id) => {
				released.push(id)
			},
		})
		expect(bot.poster).toBe("0x0b")
		expect(await bot.postNow()).toEqual({ sequence: 5n, poolRoot: 11n, birthRoot: 0n, l1Block: 30n, rootTime: 1150n })
		await expect(bot.postNow()).rejects.toThrow("no_newer_block")
		expect(groupAlive(bot.pgid)).toBe(true)

		await Promise.all([bot.stop(), bot.stop()])
		expect(groupAlive(bot.pgid)).toBe(false)
		await expect(bot.postNow()).rejects.toThrow("asp-bot stopped")
		expect(released).toEqual([c.runId])
		expect(existsSync(c.dataDir as string)).toBe(false)
	})

	it("cleans up a child that exits before ready", async () => {
		const c = config("die")
		const released: string[] = []
		const start = startBot(c, {
			command: [process.execPath, FAKE, "die"],
			removeDataOnStop: true,
			releasePorts: async (id) => {
				released.push(id)
			},
		})
		await expect(start).rejects.toThrow("before ready")
		expect(released).toEqual([c.runId])
		expect(existsSync(c.dataDir as string)).toBe(false)
	})
})
