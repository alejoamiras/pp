import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { spawnWatched } from "./process.ts"
import { groupAlive, groupGone, signalGroup } from "./process-group.ts"

const parent = join(homedir(), ".cache/pp/run-isolation")
mkdirSync(parent, { recursive: true })
const dir = mkdtempSync(join(parent, "watch-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const proc = existsSync("/proc/self/stat") || process.env.CI !== undefined

// A parent that claims one row per group, starts two watched groups and holds until killed. Group a
// logs to a file on SIGTERM and, with SIGPIPE ignored, stops only if that write succeeds; group b
// ignores SIGTERM, since an ignored signal stays ignored across `exec`.
const PARENT = `
import { claimRows } from ${JSON.stringify(join(import.meta.dir, "ports.ts"))}
import { spawnWatched } from ${JSON.stringify(join(import.meta.dir, "process.ts"))}
const [runId, ready] = process.argv.slice(2)
await claimRows(runId, { "watch-a": 40101, "watch-b": 40102 }, process.pid)
const group = (port, script, stdout) =>
	spawnWatched("sh", ["-c", script], { stdio: ["ignore", stdout, "ignore"] }, {
		release: [{ port, service: port === 40101 ? "watch-a" : "watch-b", owner: runId }],
		graceMs: 1_000,
	})
const { openSync } = await import("node:fs")
const a = group(40101, "trap '' PIPE; trap 'echo bye || sleep 60; exit 0' TERM; sleep 60 & wait", openSync(ready + ".a.log", "a"))
const b = group(40102, "trap '' TERM; exec sleep 60", "ignore")
const { writeFileSync } = await import("node:fs")
writeFileSync(ready, a.pid + " " + b.pid)
setInterval(() => {}, 1_000)
`

async function until<T>(read: () => T | undefined, ms: number): Promise<T> {
	for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) {
		const v = read()
		if (v !== undefined) return v
	}
	throw new Error(`nothing within ${ms} ms`)
}

const rows = (registry: string, runId: string) =>
	existsSync(registry)
		? readFileSync(registry, "utf8")
				.split("\n")
				.filter((l) => l.split("|")[3]?.trim() === runId)
				.map((l) => l.split("|")[2]?.trim())
		: []

test("while its parent lives, a watched command's piped output and exit code reach the parent", async () => {
	const child = spawnWatched("sh", ["-c", "echo out; echo err >&2; exit 3"], { stdio: ["ignore", "pipe", "pipe"] })
	const text = async (s: AsyncIterable<Buffer> | null) => {
		let t = ""
		for await (const chunk of s ?? []) t += chunk
		return t
	}
	const code = new Promise((resolve) => child.once("exit", resolve))
	expect(await Promise.all([text(child.stdout), text(child.stderr), code])).toEqual(["out\n", "err\n", 3])
})

describe.skipIf(!proc)("a watched group dies with the process that spawned it", () => {
	for (const runtime of ["bun", "node"]) {
		test(`under ${runtime}: SIGKILL the parent with two groups up, and both end; only the group that emptied frees its row`, async () => {
			const run = mkdtempSync(join(dir, `${runtime}-`))
			const [registry, ready, script] = ["ports.md", "ready", "parent.mjs"].map((f) => join(run, f))
			writeFileSync(script, PARENT)
			const runId = `watch-${runtime}-${process.pid}`
			const flags = runtime === "node" ? ["--no-warnings"] : []
			const p = Bun.spawn([runtime, ...flags, script, runId, ready], {
				env: { ...process.env, PP_PORTS_REGISTRY: registry },
				stdout: "inherit",
				stderr: "inherit",
			})
			let pgids: number[] = []
			try {
				pgids = (await until(() => (existsSync(ready) ? readFileSync(ready, "utf8") : undefined), 20_000)).split(" ").map(Number)
				expect(rows(registry, runId).sort()).toEqual(["watch-a", "watch-b"])
				// Alive while the parent is: the watch must not mistake a quiet pipe for a closed one.
				await Bun.sleep(500)
				for (const pgid of pgids) expect(groupAlive(pgid)).toBe(true)
				p.kill("SIGKILL")
				await p.exited
				for (const pgid of pgids) expect(await groupGone(pgid, 10_000)).toBe(true)
				// a's shutdown write landed and it stopped within the grace, so its leader released its row; b
				// outlived the grace and took its leader along.
				await until(() => (rows(registry, runId).includes("watch-a") ? undefined : true), 10_000)
				expect(rows(registry, runId)).toEqual(["watch-b"])
				expect(readFileSync(`${ready}.a.log`, "utf8")).toBe("bye\n")
			} finally {
				p.kill("SIGKILL")
				for (const pgid of pgids) signalGroup(pgid, "SIGKILL")
			}
		}, 60_000)
	}
})
