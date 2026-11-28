import { existsSync, mkdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { portsOwnedBy } from "@pp/run-isolation/ports"
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
	it("has the child claim its port in the registry the parent releases from, an override included", async () => {
		const c = config("registry")
		const scratch = join(homedir(), ".cache", "pp", "asp-bot", "unit", `${c.runId}-registry`)
		mkdirSync(scratch, { recursive: true })
		const saved = { registry: process.env.PP_PORTS_REGISTRY, home: process.env.HOME }
		process.env.PP_PORTS_REGISTRY = join(scratch, "ports.md")
		// A child that misses the override falls back under this HOME, never to the host's registry.
		process.env.HOME = join(scratch, "home")
		const port = 45_678
		let bot: Awaited<ReturnType<typeof startBot>> | undefined
		try {
			// No env file: a dotenv in the working directory must not supply the variable under test.
			bot = await startBot(c, {
				command: [process.execPath, "--no-env-file", FAKE, "claims", String(port)],
				killAfterMs: 300,
				removeDataOnStop: true,
			})
			expect([bot.url, portsOwnedBy(c.runId)]).toEqual([`http://127.0.0.1:${port}`, [port]])
			// The child dies on SIGTERM with its row still listed, so only the parent's release can clear it.
			await bot.stop()
			expect(portsOwnedBy(c.runId)).toEqual([])
			expect(existsSync(join(scratch, "home", ".agents", "ports.md"))).toBe(false)
		} finally {
			try {
				await bot?.stop()
			} finally {
				for (const [key, value] of [
					["PP_PORTS_REGISTRY", saved.registry],
					["HOME", saved.home],
				] as const) {
					if (value === undefined) delete process.env[key]
					else process.env[key] = value
				}
				rmSync(scratch, { recursive: true, force: true })
			}
		}
	})

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
		expect(await bot.postNow()).toEqual({
			sequence: 5n,
			poolRoot: 11n,
			birthRoot: 0n,
			l1Block: 30n,
			rootTime: 1150n,
			poolSize: 2n,
			birthSize: 0n,
		})
		await expect(bot.postNow()).rejects.toThrow("no_newer_block")
		expect(groupAlive(bot.pgid)).toBe(true)

		await Promise.all([bot.stop(), bot.stop()])
		expect(groupAlive(bot.pgid)).toBe(false)
		await expect(bot.postNow()).rejects.toThrow("asp-bot stopped")
		expect(released).toEqual([c.runId])
		expect(existsSync(c.dataDir as string)).toBe(false)
	})

	it("cleans up a child that exits before ready, or one still starting when the signal aborts", async () => {
		for (const [tag, command, abort, reason] of [
			["die", [process.execPath, FAKE, "die"], false, "before ready"],
			["abort", [process.execPath, "-e", "setInterval(() => {}, 1000)"], true, "boot aborted"],
		] as const) {
			const c = config(tag)
			const released: string[] = []
			const controller = new AbortController()
			const start = startBot(c, {
				command: [...command],
				removeDataOnStop: true,
				signal: controller.signal,
				releasePorts: async (id) => {
					released.push(id)
				},
			})
			if (abort) setTimeout(() => controller.abort(new Error("boot aborted")), 200)
			await expect(start, tag).rejects.toThrow(reason)
			expect(released, tag).toEqual([c.runId])
			expect(existsSync(c.dataDir as string), tag).toBe(false)
		}
		const c = config("pre-aborted")
		const start = startBot(c, { signal: AbortSignal.abort(new Error("already aborted")), command: [process.execPath, FAKE, "ok"] })
		await expect(start).rejects.toThrow("already aborted")
		expect(existsSync(c.dataDir as string), "rejected before the data dir is made").toBe(false)
	})
})
