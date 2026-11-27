import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { withFileLock } from "./lock.ts"

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

test("a lock older than staleMs is reclaimed", async () => {
	const lock = join(dir, "b.lock")
	writeFileSync(lock, "")
	const old = (Date.now() - 120_000) / 1000
	utimesSync(lock, old, old)
	expect(await withFileLock(lock, { staleMs: 60_000, waitMs: 1_000 }, () => 7)).toEqual({ value: 7 })
})
