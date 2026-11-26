import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { createRunDir, removeRunDir, RUNS_DIR, writeAtomic } from "./run-dir.ts"

const scratch = await mkdtemp(join(RUNS_DIR, "..", "local-stack-unit-"))
afterAll(() => rm(scratch, { recursive: true, force: true }))

describe("run dir", () => {
	test("holds the pid, writes atomically with no temp file left, and removes twice safely", async () => {
		const dir = await createRunDir(scratch, "stack-1-abc")
		expect(await readFile(join(dir, "pid"), "utf8")).toBe(`${process.pid}\n`)
		await writeAtomic(join(dir, "manifest.json"), "{}\n")
		await writeAtomic(join(dir, "manifest.json"), '{"v":2}\n')
		expect((await readdir(dir)).sort()).toEqual(["manifest.json", "pid"])
		expect(await readFile(join(dir, "manifest.json"), "utf8")).toBe('{"v":2}\n')
		await removeRunDir(dir)
		await removeRunDir(dir)
		expect(await readdir(scratch)).toEqual([])
	})

	test("a failed write leaves neither the target nor a temp file", async () => {
		await expect(writeAtomic(join(scratch, "missing-dir", "manifest.json"), "{}")).rejects.toThrow()
		expect(await readdir(scratch)).toEqual([])
	})
})
