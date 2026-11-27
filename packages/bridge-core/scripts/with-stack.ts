#!/usr/bin/env bun
/**
 * `bun scripts/with-stack.ts <command>…`: boots one local stack (`bun run demo --keep`) in its own
 * process group, runs each command in turn through `sh -c` in a group of its own with only
 * `PP_STACK_MANIFEST` added, stops the stack and checks it left nothing behind. Exits with the
 * first failing command's code, 1 when the stack fails to boot or anything leaves residue, 2
 * without a command, and 128 + the signal when SIGINT, SIGTERM or SIGHUP stops it (the running
 * command's group and the stack are stopped first). A command's group gets SIGTERM, then SIGKILL
 * after five seconds; processes a command leaves behind when it exits are killed and reported. A
 * leading `--` is dropped: Bun keeps one that follows another argument, not one right after the
 * script path. A stack that ignores SIGINT is killed by group after two minutes; any group of its
 * own that survives that shows up as residue (a port that still accepts, a registry row).
 */
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { connect } from "node:net"
import { constants, homedir } from "node:os"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { endGroup, groupAlive, groupGone, groupMembers } from "./process-group"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const CACHE = join(homedir(), ".cache", "pp")
const REGISTRY = join(homedir(), ".agents", "ports.md")
const READY_MS = 15 * 60_000
const STOP_MS = 120_000
const GRACE_MS = 5_000
const SETTLE_MS = 3_000
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const
/** Registry owners that belong to a stack run: its own rows and those of the services it starts. */
const OWNER_SUFFIXES = ["", "-pool", "-bot"]

/** Test seam: a JSON argv standing in for `bun run demo --keep`. */
const bootArgv = (): string[] =>
	process.env.PP_WITH_STACK_BOOT ? JSON.parse(process.env.PP_WITH_STACK_BOOT) : ["bun", "run", "demo", "--keep"]

type Run = {
	child: ChildProcess
	pgid: number
	runId: string
	/** The running command's process group. */
	command?: number
	signal?: NodeJS.Signals
	/** Command groups that outlived their shell, or survived SIGKILL. */
	leaks: string[]
}

/** Resolves with the manifest path; the run id is kept as soon as it prints, so a failed boot is still checked. */
function awaitReady(run: Run): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>()
	const timer = setTimeout(() => reject(new Error(`no PP_STACK_MANIFEST within ${READY_MS / 1000} s`)), READY_MS)
	createInterface({ input: run.child.stdout! }).on("line", (line) => {
		console.log(line)
		run.runId ||= line.match(/^\[stack\] run (\S+) pid/)?.[1] ?? ""
		const manifest = line.match(/PP_STACK_MANIFEST=(\S+)$/)?.[1]
		if (manifest) resolve(manifest)
	})
	run.child.once("exit", (code) => reject(new Error(`the stack exited with ${code} before it was ready`)))
	return promise.finally(() => clearTimeout(timer))
}

const portRefuses = (port: number) =>
	new Promise<boolean>((resolve) => {
		const s = connect({ host: "127.0.0.1", port })
		s.once("connect", () => {
			s.destroy()
			resolve(false)
		})
		s.once("error", () => resolve(true))
	})

function portsOwnedBy(runId: string): number[] {
	if (!runId || !existsSync(REGISTRY)) return []
	const owners = new Set(OWNER_SUFFIXES.map((s) => `${runId}${s}`))
	return readFileSync(REGISTRY, "utf8")
		.split("\n")
		.map((l) => l.split("|").map((c) => c.trim()))
		.filter((c) => /^\d+$/.test(c[1] ?? "") && owners.has(c[3] ?? ""))
		.map((c) => Number(c[1]))
}

/** What a stopped stack must not have left: its group, its ports and registry rows, its directories. */
async function residueOf(pgid: number, runId: string, ports: readonly number[]): Promise<string[]> {
	const left = groupAlive(pgid) ? [`process group ${pgid}`] : []
	for (const p of ports) if (!(await portRefuses(p))) left.push(`port ${p} accepts`)
	for (const p of portsOwnedBy(runId)) left.push(`registry row ${p}`)
	for (const d of [join(CACHE, "runs", runId), join(CACHE, "pp-env", "runs", `${runId}-pool`), join(CACHE, "bridge-sandbox", runId)])
		if (existsSync(d)) left.push(`dir ${d}`)
	return left
}

async function stop(run: Run): Promise<void> {
	if (run.child.exitCode !== null || run.child.signalCode !== null) return
	const exited = new Promise<void>((resolve) => run.child.once("exit", () => resolve()))
	process.kill(-run.pgid, "SIGINT")
	if (await Promise.race([exited.then(() => false), sleep(STOP_MS).then(() => true)])) {
		console.error(`[with-stack] the stack ignored SIGINT for ${STOP_MS / 1000} s; killing group ${run.pgid}`)
		process.kill(-run.pgid, "SIGKILL")
		await exited
	}
}

const signalExit = (s: NodeJS.Signals) => 128 + constants.signals[s]

/** Runs one command in its own group; once its shell exits, nothing of that group stays alive. */
async function runCommand(run: Run, command: string, manifest: string): Promise<number> {
	console.log(`[with-stack] ${command}`)
	// stdin is closed: a background group that read the terminal would stop on SIGTTIN.
	const child = spawn("sh", ["-c", command], {
		cwd: process.cwd(),
		detached: true,
		stdio: ["ignore", "inherit", "inherit"],
		env: { ...process.env, PP_STACK_MANIFEST: manifest },
	})
	const pgid = child.pid!
	run.command = pgid
	const code = await new Promise<number>((resolve) =>
		child.once("exit", (c, signal) => resolve(c ?? (signal ? signalExit(signal as NodeJS.Signals) : 1))),
	)
	run.command = undefined
	if (!run.signal) await settle(run, pgid)
	if (!(await endGroup(pgid, GRACE_MS))) run.leaks.push(`command group ${pgid} survived SIGKILL: ${membersOf(pgid)}`)
	return code
}

const membersOf = (pgid: number) =>
	groupMembers(pgid)
		.map((m) => `${m.pid} [${m.state}] ${m.args}`)
		.join("; ") || "members unavailable"

/**
 * Third-party tools leave children that exit asynchronously (a service child that quits on stdin
 * EOF), so a group still populated at shell exit gets a short window. Its members are logged either
 * way, and whatever is left after the window is killed and fails the run.
 */
async function settle(run: Run, pgid: number): Promise<void> {
	if (!groupAlive(pgid)) return
	console.error(`[with-stack] command group ${pgid} at shell exit: ${membersOf(pgid)}`)
	if (await groupGone(pgid, SETTLE_MS)) {
		console.error(`[with-stack] command group ${pgid} emptied within ${SETTLE_MS / 1000} s`)
		return
	}
	run.leaks.push(`command group ${pgid} outlived its shell by ${SETTLE_MS / 1000} s: ${membersOf(pgid)}`)
}

async function runCommands(run: Run, commands: readonly string[], manifest: string): Promise<number> {
	for (const command of commands) {
		const code = run.signal ? 0 : await runCommand(run, command, manifest)
		if (run.signal) return signalExit(run.signal)
		if (code !== 0) return code
	}
	return 0
}

/** The first SIGINT, SIGTERM or SIGHUP stops the running command and ends the wait for the stack. */
function onSignals(run: Run): { interrupted: Promise<never>; dispose: () => void } {
	const { promise, reject } = Promise.withResolvers<never>()
	promise.catch(() => {})
	const handler = (s: NodeJS.Signals) => {
		if (run.signal) return
		run.signal = s
		if (run.command) void endGroup(run.command, GRACE_MS)
		reject(new Error(`received ${s}`))
	}
	for (const s of SIGNALS) process.on(s, handler)
	const dispose = () => {
		for (const s of SIGNALS) process.off(s, handler)
	}
	return { interrupted: promise, dispose }
}

async function main(argv: readonly string[]): Promise<number> {
	const commands = argv[0] === "--" ? argv.slice(1) : argv
	if (commands.length === 0) {
		console.error("usage: bun scripts/with-stack.ts <command>…")
		return 2
	}
	// The stack under test is the one this run boots, never one an outer shell attached to.
	const env = { ...process.env, PP_STACK_MANIFEST: undefined }
	const [cmd, ...args] = bootArgv()
	const child = spawn(cmd!, args, { cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "inherit"], env })
	const run: Run = { child, pgid: child.pid!, runId: "", leaks: [] }
	const signals = onSignals(run)
	let code = 1
	let ports: number[] = []
	try {
		const manifest = await Promise.race([awaitReady(run), signals.interrupted])
		ports = portsOwnedBy(run.runId)
		code = await runCommands(run, commands, manifest)
	} catch (err) {
		console.error(`[with-stack] ${err instanceof Error ? err.message : String(err)}`)
	} finally {
		if (ports.length === 0) ports = portsOwnedBy(run.runId)
		await stop(run)
		signals.dispose()
	}
	const left = [...run.leaks, ...(run.runId ? await residueOf(run.pgid, run.runId, ports) : [])]
	if (left.length) console.error(`[with-stack] residue: ${left.join("; ")}`)
	if (run.signal) return signalExit(run.signal)
	return left.length && code === 0 ? 1 : code
}

process.exit(await main(process.argv.slice(2)))
