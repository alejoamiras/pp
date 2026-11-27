import { type ChildProcess, spawn } from "node:child_process"
import { createWriteStream, mkdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { fileURLToPath } from "node:url"
import { type Hex, MAX_OBSERVATION_LAG, type RootRecord } from "@pp/label-paths"
import { registryPath, releaseRows } from "@pp/run-isolation/ports"
import type { L1Tag } from "./l1"
import { decodeRecord, line, type PostNowReply, parseLine, type ReadyEvent } from "./protocol"

/** The stack manifest's fields the bot reads; a full `StackManifest` satisfies it. */
export type BotManifest = { l1Rpc: string; aztecNode: string; pool: { aspRegistry: Hex; aspApiUrl: string } }

export type BotConfig = {
	manifest: BotManifest
	/** The registry's `AztecAddress.toString()`. */
	registry: Hex
	/** Labelled tokens whose births the intake approves; none by default, so the birth root stays 0. */
	tokens?: Hex[]
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
	/** Resolves with the record a post sent after this call landed; rejects with the bot's reason, or at once after exit or `stop()`. */
	postNow(timeoutMs?: number): Promise<RootRecord>
	/** Stops the whole process group, releases the run's port rows, and removes `dataDir` when asked. Idempotent. */
	stop(): Promise<void>
}

export type StartOptions = {
	removeDataOnStop?: boolean
	readyTimeoutMs?: number
	/** An abort before ready rejects the start and stops the child, as a timeout does. */
	signal?: AbortSignal
	killAfterMs?: number
	/** Test seams: the child's command line and the port release. */
	command?: string[]
	releasePorts?: (runId: string) => Promise<void>
}

const CACHE = join(homedir(), ".cache", "pp", "asp-bot")
const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url))

const releaseByRunId = (registry: string) => async (runId: string) => {
	if (!(await releaseRows(runId, registry))) throw new Error(`${registry} stayed locked; the rows owned by ${runId} are still there`)
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

/** Resolves on the `ready` line `onReady` receives; rejects on exit, spawn error, timeout or abort. */
function waitReady(
	child: ChildProcess,
	o: StartOptions,
	logPath: string,
	onReady: (f: (e: ReadyEvent) => void) => void,
): Promise<ReadyEvent> {
	const ms = o.readyTimeoutMs ?? 300_000
	return new Promise<ReadyEvent>((ok, fail) => {
		const settle = (f: () => void) => {
			clearTimeout(timer)
			o.signal?.removeEventListener("abort", onAbort)
			f()
		}
		const timer = setTimeout(() => settle(() => fail(new Error(`asp-bot not ready after ${ms} ms; log: ${logPath}`))), ms)
		const onAbort = () => settle(() => fail(o.signal?.reason ?? new Error("aborted")))
		if (o.signal?.aborted) return onAbort()
		o.signal?.addEventListener("abort", onAbort, { once: true })
		onReady((e) => settle(() => ok(e)))
		child.once("exit", (code, signal) =>
			settle(() => fail(new Error(`asp-bot exited (${signal ?? code}) before ready; log: ${logPath}`))),
		)
		child.once("error", (e) => settle(() => fail(e)))
	})
}

/** Matches post-now replies to requests by id. Once closed, pending and later requests reject at once. */
function postNowChannel(child: ChildProcess) {
	const pending = new Map<number, { ok: (r: RootRecord) => void; fail: (e: Error) => void }>()
	let nextId = 1
	let closed: string | undefined
	const close = (why: string) => {
		closed ??= why
		for (const p of pending.values()) p.fail(new Error(closed))
		pending.clear()
	}
	const deliver = (r: PostNowReply) => {
		const p = pending.get(r.id)
		pending.delete(r.id)
		if (p) r.ok ? p.ok(decodeRecord(r.record)) : p.fail(new Error(r.reason))
	}
	const postNow = (timeoutMs = 120_000) =>
		new Promise<RootRecord>((ok, fail) => {
			if (closed) return fail(new Error(closed))
			const id = nextId++
			const timer = setTimeout(() => {
				pending.delete(id)
				fail(new Error("timeout"))
			}, timeoutMs)
			const settled =
				<T>(f: (v: T) => void) =>
				(v: T) => {
					clearTimeout(timer)
					f(v)
				}
			pending.set(id, { ok: settled(ok), fail: settled(fail) })
			child.stdin?.write(line({ cmd: "post-now", id }))
		})
	return { postNow, deliver, close }
}

/**
 * Starts the bot and its embedded PXE in a child process in its own process group, and resolves on
 * its `ready` line, which it prints once `/latest` serves. A start that fails cleans up as `stop()` does.
 */
export async function startBot(c: BotConfig, o: StartOptions = {}): Promise<BotHandle> {
	o.signal?.throwIfAborted()
	// Ports are released by owner id, so a shared id would release the stack's rows too.
	if (c.runId === c.stackRunId) throw new Error(`runId must differ from stackRunId (${c.stackRunId})`)
	const margin = c.inclusionMarginSec
	if (!Number.isSafeInteger(margin) || margin < 0 || BigInt(margin) >= MAX_OBSERVATION_LAG)
		throw new RangeError(`inclusionMarginSec must be in [0, ${MAX_OBSERVATION_LAG}): ${margin}`)
	const dataDir = c.dataDir ?? join(CACHE, "runs", c.runId)
	mkdirSync(join(dataDir, "tmp"), { recursive: true })
	mkdirSync(join(CACHE, "logs"), { recursive: true })
	const logPath = join(CACHE, "logs", `${c.runId}.log`)
	const log = createWriteStream(logPath, { flags: "a" })
	// A full disk must cost the log, not crash the caller with an unhandled stream error.
	log.on("error", (e) => process.stderr.write(`[asp-bot] log ${logPath}: ${e.message}\n`))
	// Resolved once: the child claims here and `stop` releases here, even if the caller's env changes between.
	const registry = registryPath()
	const bun = process.versions.bun ? process.execPath : "bun"
	const [cmd, ...args] = o.command ?? [bun, CLI, "run"]
	const child = spawn(cmd as string, args, {
		detached: true,
		stdio: ["pipe", "pipe", "pipe"],
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? homedir(),
			TMPDIR: join(dataDir, "tmp"),
			PP_PORTS_REGISTRY: registry,
			PP_BOT_CONFIG: JSON.stringify({ ...c, dataDir }),
		},
	})
	const pgid = child.pid as number
	child.stderr?.pipe(log, { end: false })

	const channel = postNowChannel(child)
	child.once("exit", (code, signal) => channel.close(`asp-bot exited (${signal ?? code}); log: ${logPath}`))
	let onReady: ((e: ReadyEvent) => void) | undefined
	createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (text) => {
		log.write(`${text}\n`)
		const e = parseLine(text)
		if (e?.event === "ready") onReady?.(e as ReadyEvent)
		if (e?.event === "post-now") channel.deliver(e as PostNowReply)
	})

	let stopping: Promise<void> | undefined
	const stop = () => {
		channel.close("asp-bot stopped")
		stopping ??= (async () => {
			await killGroup(child, pgid, o.killAfterMs ?? 30_000)
			await (o.releasePorts ?? releaseByRunId(registry))(c.runId)
			if (o.removeDataOnStop) rmSync(dataDir, { recursive: true, force: true })
			await new Promise((r) => (log.destroyed ? r(undefined) : log.end(r)))
		})()
		return stopping
	}

	let ready: ReadyEvent
	try {
		ready = await waitReady(child, o, logPath, (f) => {
			onReady = f
		})
	} catch (e) {
		await stop()
		throw e
	}

	return {
		url: ready.url,
		poster: ready.poster as Hex,
		birthIntake: ready.birthIntake as Hex,
		runId: c.runId,
		pgid,
		postNow: channel.postNow,
		stop,
	}
}
