import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { withFileLock } from "./lock.ts"

const parent = join(homedir(), ".cache/pp/pp-env")
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

test("a lock older than staleMs is reclaimed", async () => {
	const lock = join(dir, "b.lock")
	writeFileSync(lock, "")
	const old = (Date.now() - 120_000) / 1000
	utimesSync(lock, old, old)
	expect(await withFileLock(lock, { staleMs: 60_000, waitMs: 1_000 }, () => 7)).toEqual({ value: 7 })
})
