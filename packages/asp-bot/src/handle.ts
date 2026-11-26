import { type ChildProcess, spawn } from "node:child_process"
import { createWriteStream, mkdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import type { Hex, RootRecord } from "@pp/label-paths"
import type { L1Tag } from "./l1"
import { decodeRecord, line, type PostNowReply, parseLine, type ReadyEvent } from "./protocol"

/** The stack manifest's fields the bot reads; a full `StackManifest` satisfies it. */
export type BotManifest = { l1Rpc: string; aztecNode: string; pool: { aspRegistry: Hex; aspApiUrl: string } }

export type BotConfig = {
	manifest: BotManifest
	/** The registry's `AztecAddress.toString()`. */
	registry: Hex
	tag: L1Tag
	/** Binds the bot's local account seeds to one stack. */
	stackRunId: string
	/** Owns the bot's port row and its log file. */
	runId: string
	/** Holds only the wallet store; default `~/.cache/pp/asp-bot/runs/<runId>`. */
	dataDir?: string
	inclusionMarginSec: number
}

export interface BotHandle {
	url: string
	poster: Hex
	birthIntake: Hex
	runId: string
	pgid: number
	/** Resolves with the record a post sent after this call landed; rejects with the bot's reason otherwise. */
	postNow(timeoutMs?: number): Promise<RootRecord>
	/** Stops the whole process group, releases the run's port rows, and removes `dataDir` when asked. Idempotent. */
	stop(): Promise<void>
}

export type StartOptions = {
	removeDataOnStop?: boolean
	readyTimeoutMs?: number
	killAfterMs?: number
	/** Test seams: the child's command line and the port release. */
	command?: string[]
	releasePorts?: (runId: string) => Promise<void>
}

const CACHE = join(homedir(), ".cache", "pp", "asp-bot")
const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url))

const releaseByRunId = async (runId: string) => {
	const { releaseHostPorts } = await import("@pp/bridge-core/sandbox")
	await releaseHostPorts(runId, {})
}

const signalGroup = (pgid: number, signal: NodeJS.Signals | 0): boolean => {
	try {
		process.kill(-pgid, signal)
		return true
	} catch {
		return false
	}
}

const exited = (child: ChildProcess, ms: number) =>
	child.exitCode !== null || child.signalCode !== null
		? Promise.resolve(true)
		: new Promise<boolean>((ok) => {
				const timer = setTimeout(() => ok(false), ms)
				child.once("exit", () => {
					clearTimeout(timer)
					ok(true)
				})
			})

/** SIGTERM to the group, SIGKILL after `killAfterMs`, then wait until no member is left. */
async function killGroup(child: ChildProcess, pgid: number, killAfterMs: number): Promise<void> {
	child.stdin?.end()
	signalGroup(pgid, "SIGTERM")
	if (!(await exited(child, killAfterMs))) signalGroup(pgid, "SIGKILL")
	await exited(child, killAfterMs)
	// A member that outlived the leader (a worker it spawned) still holds the group.
	for (let i = 0; i < 50 && signalGroup(pgid, 0); i++) {
		signalGroup(pgid, "SIGKILL")
		await new Promise((r) => setTimeout(r, 100))
	}
}

/**
 * Starts the bot and its embedded PXE in a child process in its own process group, and resolves on
 * its `ready` line, which it prints once `/latest` serves. A start that fails cleans up as `stop()` does.
 */
export async function startBot(c: BotConfig, o: StartOptions = {}): Promise<BotHandle> {
	const dataDir = c.dataDir ?? join(CACHE, "runs", c.runId)
	mkdirSync(join(dataDir, "tmp"), { recursive: true })
	mkdirSync(join(CACHE, "logs"), { recursive: true })
	const logPath = join(CACHE, "logs", `${c.runId}.log`)
	const log = createWriteStream(logPath, { flags: "a" })
	const bun = process.versions.bun ? process.execPath : "bun"
	const [cmd, ...args] = o.command ?? [bun, CLI, "run"]
	const child = spawn(cmd as string, args, {
		detached: true,
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? homedir(),
			TMPDIR: join(dataDir, "tmp"),
			PP_BOT_CONFIG: JSON.stringify({ ...c, dataDir }),
		},
	})
	const pgid = child.pid as number
	child.stderr?.pipe(log, { end: false })

	const replies = new Map<number, (r: PostNowReply) => void>()
	let onReady: ((e: ReadyEvent) => void) | undefined
	createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (text) => {
		log.write(`${text}\n`)
		const e = parseLine(text)
		if (e?.event === "ready") onReady?.(e as ReadyEvent)
		if (e?.event === "post-now") replies.get(e.id as number)?.(e as PostNowReply)
	})

	let stopping: Promise<void> | undefined
	const stop = () => {
		stopping ??= (async () => {
			await killGroup(child, pgid, o.killAfterMs ?? 30_000)
			await (o.releasePorts ?? releaseByRunId)(c.runId)
			if (o.removeDataOnStop) rmSync(dataDir, { recursive: true, force: true })
			await new Promise((r) => log.end(r))
		})()
		return stopping
	}

	let ready: ReadyEvent
	try {
		ready = await new Promise<ReadyEvent>((ok, fail) => {
			const timer = setTimeout(
				() => fail(new Error(`asp-bot not ready after ${o.readyTimeoutMs ?? 300_000} ms; log: ${logPath}`)),
				o.readyTimeoutMs ?? 300_000,
			)
			onReady = (e) => {
				clearTimeout(timer)
				ok(e)
			}
			child.once("exit", (code, signal) => {
				clearTimeout(timer)
				fail(new Error(`asp-bot exited (${signal ?? code}) before ready; log: ${logPath}`))
			})
			child.once("error", (e) => {
				clearTimeout(timer)
				fail(e)
			})
		})
	} catch (e) {
		await stop()
		throw e
	}

	let nextId = 1
	const postNow = (timeoutMs = 120_000) =>
		new Promise<RootRecord>((ok, fail) => {
			const id = nextId++
			const timer = setTimeout(() => {
				replies.delete(id)
				fail(new Error("timeout"))
			}, timeoutMs)
			replies.set(id, (r) => {
				clearTimeout(timer)
				replies.delete(id)
				r.ok ? ok(decodeRecord(r.record)) : fail(new Error(r.reason))
			})
			child.stdin?.write(line({ cmd: "post-now", id }))
		})

	return { url: ready.url, poster: ready.poster as Hex, birthIntake: ready.birthIntake as Hex, runId: c.runId, pgid, postNow, stop }
}
