import { afterAll, expect, test } from "bun:test"
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { type LockFs, withFileLock } from "./lock.ts"

const parent = join(homedir(), ".cache/pp/run-isolation")
mkdirSync(parent, { recursive: true })
const dir = mkdtempSync(join(parent, "lock-test-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test("holders never overlap, and a held lock times out", async () => {
	const lock = join(dir, "a.lock")
	let inside = 0
	let overlapped = false
	const hold = () =>
		withFileLock(lock, { staleMs: 60_000, waitMs: 5_000 }, async () => {
			overlapped ||= ++inside > 1
			await Bun.sleep(150)
			inside--
		})
	const results = await Promise.all([hold(), hold(), hold()])
	expect(overlapped).toBe(false)
	expect(results.every((r) => r !== undefined)).toBe(true)
	writeFileSync(lock, "")
	expect(await withFileLock(lock, { staleMs: 60_000, waitMs: 300 }, () => 1)).toBeUndefined()
})

test("a live holder that outlasts staleMs keeps its lock", async () => {
	const lock = join(dir, "c.lock")
	const o = { staleMs: 300, waitMs: 5_000 }
	let inside = 0
	let overlapped = false
	const hold = (ms: number) =>
		withFileLock(lock, o, async () => {
			overlapped ||= ++inside > 1
			await Bun.sleep(ms)
			inside--
		})
	await Promise.all([hold(1_000), Bun.sleep(50).then(() => hold(10))])
	expect(overlapped).toBe(false)
})

test("a holder whose lock was reclaimed neither renews nor removes the new one", async () => {
	const lock = join(dir, "d.lock")
	const old = (Date.now() - 60_000) / 1000
	await withFileLock(lock, { staleMs: 300, waitMs: 1_000 }, async () => {
		unlinkSync(lock)
		writeFileSync(lock, "another holder")
		utimesSync(lock, old, old)
		await Bun.sleep(400)
	})
	expect(statSync(lock).mtimeMs).toBe(old * 1000)
})

test("of two processes reclaiming one stale lock, only one holds the lock at a time", async () => {
	const lock = join(dir, "e.lock")
	const [aIn, aOut, go] = ["e.a-in", "e.a-out", "e.go"].map((f) => join(dir, f))
	writeFileSync(lock, "a dead holder")
	const old = (Date.now() - 120_000) / 1000
	utimesSync(lock, old, old)
	// A takes the lock with the real calls and holds it until B has put it back (or for 5 s).
	const holder = `import { existsSync, writeFileSync } from "node:fs"
	import { withFileLock } from ${JSON.stringify(join(import.meta.dir, "lock.ts"))}
	await withFileLock(${JSON.stringify(lock)}, { staleMs: 60_000, waitMs: 10_000 }, async () => {
		writeFileSync(${JSON.stringify(aIn)}, "")
		for (const end = Date.now() + 5_000; !existsSync(${JSON.stringify(go)}) && Date.now() < end; ) await Bun.sleep(10)
		writeFileSync(${JSON.stringify(aOut)}, "")
	})`
	let a: ReturnType<typeof Bun.spawn> | undefined
	let aHeld = false
	let restored: string | undefined
	// B judges the dead holder's lock stale, then stalls before its first change to it until A has
	// reclaimed the lock and holds it (or for 5 s, which fails the test).
	const stall = () => {
		if (a !== undefined) return
		a = Bun.spawn(["bun", "-e", holder], { stdout: "inherit", stderr: "inherit" })
		for (const end = Date.now() + 5_000; !existsSync(aIn) && Date.now() < end; ) Bun.sleepSync(10)
		aHeld = existsSync(aIn)
	}
	const stalls: LockFs = {
		stat: (path) => statSync(path),
		rename: (from, to) => {
			stall()
			renameSync(from, to)
		},
		link: (existing, path) => {
			linkSync(existing, path)
			restored = readFileSync(path, "utf8")
			writeFileSync(go, "")
		},
		unlink: (path) => {
			stall()
			unlinkSync(path)
		},
	}
	let overlapped = false
	const b = await withFileLock(
		lock,
		{ staleMs: 60_000, waitMs: 15_000 },
		() => {
			overlapped = existsSync(aIn) && !existsSync(aOut)
		},
		stalls,
	)
	expect(b).toBeDefined()
	expect(await a?.exited).toBe(0)
	expect({ aHeld, overlapped }).toEqual({ aHeld: true, overlapped: false })
	// B found A's live lock where the dead one had been and put it back, token and all.
	expect(restored?.startsWith(`${a?.pid}:`)).toBe(true)
	expect(readdirSync(dir).filter((f) => f.startsWith("e.lock"))).toEqual([])
}, 30_000)

test("a reclaimer that cannot judge the lock it moved aside puts it back", async () => {
	const lock = join(dir, "f.lock")
	writeFileSync(lock, "a holder")
	const old = (Date.now() - 120_000) / 1000
	utimesSync(lock, old, old)
	const blind: LockFs = {
		stat: (path) => {
			if (path !== lock) throw new Error("EIO")
			return statSync(path)
		},
		rename: (from, to) => renameSync(from, to),
		link: (existing, path) => linkSync(existing, path),
		unlink: (path) => unlinkSync(path),
	}
	expect(await withFileLock(lock, { staleMs: 60_000, waitMs: 300 }, () => 1, blind)).toBeUndefined()
	expect(readFileSync(lock, "utf8")).toBe("a holder")
})

test("a lock older than staleMs is reclaimed", async () => {
	const lock = join(dir, "b.lock")
	writeFileSync(lock, "")
	const old = (Date.now() - 120_000) / 1000
	utimesSync(lock, old, old)
	expect(await withFileLock(lock, { staleMs: 60_000, waitMs: 1_000 }, () => 7)).toEqual({ value: 7 })
})
