#!/usr/bin/env bun
/**
 * `bun scripts/with-stack.ts <command>…`: boots one local stack (`bun run demo --keep`) in its own
 * process group, runs each command in turn through `sh -c` with only `PP_STACK_MANIFEST` added,
 * stops the stack and checks it left nothing behind. Exits with the first failing command's code,
 * 1 when the stack fails to boot or leaves residue, 2 without a command. A leading `--` is dropped:
 * Bun keeps one that follows another argument, not one right after the script path.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { connect } from "node:net"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")
const CACHE = join(homedir(), ".cache", "pp")
const REGISTRY = join(homedir(), ".agents", "ports.md")
const READY_MS = 15 * 60_000
const STOP_MS = 120_000

type Booted = { manifest: string; runId: string }

function bootStack(child: ChildProcess): Promise<Booted> {
	const { promise, resolve, reject } = Promise.withResolvers<Booted>()
	let runId = ""
	const timer = setTimeout(() => reject(new Error(`no PP_STACK_MANIFEST within ${READY_MS / 1000} s`)), READY_MS)
	createInterface({ input: child.stdout! }).on("line", (line) => {
		console.log(line)
		runId ||= line.match(/^\[stack\] run (\S+) pid/)?.[1] ?? ""
		const manifest = line.match(/PP_STACK_MANIFEST=(\S+)$/)?.[1]
		if (manifest) resolve({ manifest, runId })
	})
	child.once("exit", (code) => reject(new Error(`the stack exited with ${code} before it was ready`)))
	return promise.finally(() => clearTimeout(timer))
}

const groupAlive = (pgid: number) => {
	try {
		process.kill(-pgid, 0)
		return true
	} catch (err) {
		return (err as NodeJS.ErrnoException).code !== "ESRCH"
	}
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
	if (!existsSync(REGISTRY)) return []
	return readFileSync(REGISTRY, "utf8")
		.split("\n")
		.map((l) => l.split("|").map((c) => c.trim()))
		.filter((c) => /^\d+$/.test(c[1] ?? "") && (c[3] === runId || c[3] === `${runId}-pool`))
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

async function stop(child: ChildProcess, pgid: number): Promise<void> {
	if (child.exitCode !== null) return
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
	process.kill(-pgid, "SIGINT")
	const timedOut = await Promise.race([exited.then(() => false), sleep(STOP_MS).then(() => true)])
	if (timedOut) {
		console.error(`[with-stack] the stack ignored SIGINT for ${STOP_MS / 1000} s; killing group ${pgid}`)
		process.kill(-pgid, "SIGKILL")
		await exited
	}
}

function runCommands(commands: readonly string[], manifest: string): number {
	for (const command of commands) {
		console.log(`[with-stack] ${command}`)
		const r = spawnSync("sh", ["-c", command], {
			cwd: process.cwd(),
			stdio: "inherit",
			env: { ...process.env, PP_STACK_MANIFEST: manifest },
		})
		const code = r.status ?? 1
		if (code !== 0) return code
	}
	return 0
}

async function main(argv: readonly string[]): Promise<number> {
	const commands = argv[0] === "--" ? argv.slice(1) : argv
	if (commands.length === 0) {
		console.error("usage: bun scripts/with-stack.ts <command>…")
		return 2
	}
	// The stack under test is the one this run boots, never one an outer shell attached to.
	const env = { ...process.env, PP_STACK_MANIFEST: undefined }
	const child = spawn("bun", ["run", "demo", "--keep"], { cwd: ROOT, detached: true, stdio: ["ignore", "pipe", "inherit"], env })
	const pgid = child.pid!
	let code = 1
	let runId = ""
	let ports: number[] = []
	try {
		const booted = await bootStack(child)
		runId = booted.runId
		ports = portsOwnedBy(runId)
		code = runCommands(commands, booted.manifest)
	} catch (err) {
		console.error(`[with-stack] ${err instanceof Error ? err.message : String(err)}`)
	} finally {
		await stop(child, pgid)
	}
	const left = runId ? await residueOf(pgid, runId, ports) : []
	if (left.length) console.error(`[with-stack] residue: ${left.join("; ")}`)
	return left.length && code === 0 ? 1 : code
}

process.exit(await main(process.argv.slice(2)))
