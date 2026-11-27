import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { groupAlive, groupGone, signalGroup } from "./process-group.ts"

const parent = join(homedir(), ".cache/pp/run-isolation")
mkdirSync(parent, { recursive: true })
const dir = mkdtempSync(join(parent, "watch-test-"))
// What a failed case may leave: the parents it started and the groups they lead.
const parents: { kill: (signal: NodeJS.Signals) => void }[] = []
const groups: number[] = []
afterAll(async () => {
	for (const p of parents) p.kill("SIGKILL")
	for (const g of groups) signalGroup(g, "SIGKILL")
	for (const g of groups) await groupGone(g, 5_000)
	rmSync(dir, { recursive: true, force: true })
})

const proc = existsSync("/proc/self/stat") || process.env.CI !== undefined
const RUNTIMES = ["bun", "node"]
const flagsOf = (runtime: string) => (runtime === "node" ? ["--no-warnings"] : [])

async function until<T>(read: () => T | undefined, ms: number): Promise<T> {
	for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) {
		const v = read()
		if (v !== undefined) return v
	}
	throw new Error(`nothing within ${ms} ms`)
}

// A parent that starts one watched command (with the environment LIFE_ENV names, if any) and prints its
// output and how it ended.
const LIFE = `
import { spawnWatched } from ${JSON.stringify(join(import.meta.dir, "process.ts"))}
const [cmd, ...args] = process.argv.slice(2)
const env = process.env.LIFE_ENV ? JSON.parse(process.env.LIFE_ENV) : undefined
const c = spawnWatched(cmd, args, { stdio: ["ignore", "pipe", "ignore"], env })
let out = ""
c.stdout.on("data", (d) => (out += d))
c.on("close", (code, signal) => console.log(JSON.stringify({ out, end: signal ?? code })))
`
const life = join(dir, "life.mjs")
writeFileSync(life, LIFE)

async function runLife(runtime: string, command: string[], o: { cwd?: string; env?: Record<string, string> } = {}) {
	const env = { ...process.env, ...(o.env ? { LIFE_ENV: JSON.stringify(o.env) } : {}) }
	const p = Bun.spawn([runtime, ...flagsOf(runtime), life, ...command], {
		cwd: o.cwd,
		env,
		stdout: "pipe",
		stderr: "inherit",
		timeout: 15_000,
	})
	parents.push(p)
	return JSON.parse((await new Response(p.stdout).text()) || "null") as { out: string; end: number | string } | null
}

describe("while its parent lives, a watched command's output and the way it ended reach the parent", () => {
	for (const runtime of RUNTIMES) {
		test(`under ${runtime}`, async () => {
			expect(await runLife(runtime, ["sh", "-c", "echo out; exit 3"])).toEqual({ out: "out\n", end: 3 })
			expect(await runLife(runtime, ["sh", "-c", "kill -TERM $$"])).toEqual({ out: "", end: "SIGTERM" })
			expect(await runLife(runtime, [join(dir, "no-such-command")])).toEqual({ out: "", end: 127 })
			// The watch stays with the leader: the command holds only its stdio, so ls opens its listing at fd 3.
			if (existsSync("/proc/self/fd"))
				expect(await runLife(runtime, ["ls", "/proc/self/fd"])).toEqual({ out: "0\n1\n2\n3\n", end: 0 })
		}, 60_000)
	}
})

test("a watched command gets the environment it was given, not a .env from the working directory", async () => {
	const cwd = mkdtempSync(join(dir, "env-"))
	writeFileSync(join(cwd, ".env"), "PP_WATCH_SENTINEL=leaked\n")
	const env = { PATH: process.env.PATH ?? "" }
	expect(await runLife("bun", ["sh", "-c", "printenv PP_WATCH_SENTINEL || echo absent"], { cwd, env })).toEqual({
		out: "absent\n",
		end: 0,
	})
}, 30_000)

// A parent that claims one row per group, starts two watched groups and holds until killed. Group a logs to
// a file on SIGTERM and, with SIGPIPE ignored, stops only if that write succeeds. In group b the command
// stops on SIGTERM but leaves a member that ignores it (an ignored signal stays ignored across `exec`).
// Each group marks itself ready once its traps are set.
const PARENT = `
import { openSync, renameSync, writeFileSync } from "node:fs"
import { claimRows } from ${JSON.stringify(join(import.meta.dir, "ports.ts"))}
import { spawnWatched } from ${JSON.stringify(join(import.meta.dir, "process.ts"))}
const [runId, ready] = process.argv.slice(2)
await claimRows(runId, { "watch-a": 40101, "watch-b": 40102 }, process.pid)
const group = (port, service, script, stdout) =>
	spawnWatched("sh", ["-c", script], { stdio: ["ignore", stdout, "ignore"], env: { ...process.env, READY: ready + "." + service } }, {
		release: [{ port, service, owner: runId }],
		graceMs: 5_000,
	})
const a = group(40101, "watch-a", "trap '' PIPE; trap 'echo bye || sleep 60; exit 0' TERM; echo > \\"$READY\\"; sleep 60 & wait", openSync(ready + ".a.log", "a"))
const b = group(40102, "watch-b", "trap 'exit 0' TERM; (trap '' TERM; echo > \\"$READY\\"; exec sleep 60) & wait", "ignore")
writeFileSync(ready + ".tmp", a.pid + " " + b.pid)
renameSync(ready + ".tmp", ready)
setInterval(() => {}, 1_000)
`

const rows = (registry: string, runId: string) =>
	existsSync(registry)
		? readFileSync(registry, "utf8")
				.split("\n")
				.filter((l) => l.split("|")[3]?.trim() === runId)
				.map((l) => l.split("|")[2]?.trim())
		: []

describe.skipIf(!proc)("a watched group dies with the process that spawned it", () => {
	for (const runtime of RUNTIMES) {
		test(`under ${runtime}: SIGKILL the parent with two groups up, and both end; only the group that emptied frees its row`, async () => {
			const run = mkdtempSync(join(dir, `${runtime}-`))
			const [registry, ready, script] = ["ports.md", "ready", "parent.mjs"].map((f) => join(run, f))
			writeFileSync(script, PARENT)
			const runId = `watch-${runtime}-${process.pid}`
			const p = Bun.spawn([runtime, ...flagsOf(runtime), script, runId, ready], {
				env: { ...process.env, PP_PORTS_REGISTRY: registry },
				stdout: "inherit",
				stderr: "inherit",
			})
			parents.push(p)
			const [a, b] = (await until(() => (existsSync(ready) ? readFileSync(ready, "utf8") : undefined), 20_000)).split(" ").map(Number)
			groups.push(a as number, b as number)
			// A gone group leaves cleanup: its number may already name someone else's.
			const retire = (g: number) => groups.splice(groups.indexOf(g), 1)
			await until(() => (existsSync(`${ready}.watch-a`) && existsSync(`${ready}.watch-b`) ? true : undefined), 20_000)
			expect(rows(registry, runId).sort()).toEqual(["watch-a", "watch-b"])
			// Alive while the parent is: the watch must not mistake a quiet pipe for a closed one.
			await Bun.sleep(500)
			expect([groupAlive(a as number), groupAlive(b as number)]).toEqual([true, true])
			p.kill("SIGKILL")
			await p.exited
			// Within b's grace: a's shutdown write landed, a ended and freed its row; b's leftover member is
			// still running, so b's row stays claimed.
			await until(() => (!groupAlive(a as number) && !rows(registry, runId).includes("watch-a") ? true : undefined), 4_000)
			retire(a as number)
			expect(groupAlive(b as number)).toBe(true)
			expect(rows(registry, runId)).toEqual(["watch-b"])
			expect(readFileSync(`${ready}.a.log`, "utf8")).toBe("bye\n")
			// The leftover outlives the grace: the whole group goes, its leader with it, and the row stays.
			expect(await groupGone(b as number, 15_000)).toBe(true)
			retire(b as number)
			expect(rows(registry, runId)).toEqual(["watch-b"])
		}, 60_000)
	}
})
