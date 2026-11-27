import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { sha256 } from "./download"
import { type CrsPin, prepareCrs, readCrsPin } from "./crs"

const g1c = Buffer.alloc(64, 1)
const g2 = Buffer.alloc(16, 2)
const grumpkin = Buffer.alloc(32, 3)
const g1 = Buffer.alloc(128, 4)
const input = (name: string, b: Buffer, ranged: boolean) => ({
	urls: [`http://primary.invalid/${name}`, `http://fallback.invalid/${name}`] as [string, string],
	ranged,
	bytes: b.length,
	sha256: sha256(b),
})
const pin: CrsPin = {
	bb: readCrsPin().bb,
	inputs: {
		"bn254_g1_compressed.dat": input("g1", g1c, true),
		"bn254_g2.dat": input("g2", g2, false),
		"grumpkin_g1_v2.flat.dat": input("grumpkin", grumpkin, true),
	},
	g1Uncompressed: { bytes: g1.length, sha256: sha256(g1) },
}

/** Serves each file by its last path segment; `override` replaces one body. */
const cdn = (override: Record<string, Buffer> = {}) =>
	(async (url: string) => {
		const name = url.split("/").pop() as string
		const body = override[name] ?? { g1: g1c, g2, grumpkin }[name]
		return body ? new Response(new Uint8Array(body)) : new Response(null, { status: 404 })
	}) as unknown as typeof fetch

const dirs: string[] = []
const fresh = () => {
	mkdirSync(join(homedir(), ".cache/pp"), { recursive: true })
	const d = mkdtempSync(join(homedir(), ".cache/pp/crs-test-"))
	dirs.push(d)
	return join(d, "crs")
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("prepareCrs", () => {
	it("returns the three arrays once every input and the decompressed G1 match", async () => {
		const decompress = vi.fn(async (dir: string) => writeFileSync(join(dir, "bn254_g1.dat"), g1))
		const seed = await prepareCrs(pin, fresh(), { fetchImpl: cdn(), decompress })
		expect(decompress).toHaveBeenCalledOnce()
		expect([seed.g1Data, seed.g2Data, seed.grumpkinG1DataV2]).toEqual([g1, g2, grumpkin])
	})

	it.each([
		["a flipped byte", Buffer.from(g1c).fill(9, 0, 1)],
		["a short body", g1c.subarray(1)],
		["a long body", Buffer.concat([g1c, Buffer.alloc(1)])],
	])("refuses an input with %s before bb.js runs", async (_why, bad) => {
		const decompress = vi.fn(async () => {})
		await expect(prepareCrs(pin, fresh(), { fetchImpl: cdn({ g1: bad }), decompress })).rejects.toThrow(/crs: both hosts failed/)
		expect(decompress).not.toHaveBeenCalled()
	})

	it.each([
		["an input", { ...pin, inputs: { ...pin.inputs, "bn254_g2.dat": { ...pin.inputs["bn254_g2.dat"], sha256: "" } } }],
		["the decompressed G1", { ...pin, g1Uncompressed: { ...pin.g1Uncompressed, sha256: "" } }],
	])("refuses a pin whose hash for %s is not a sha256, before downloading", async (_what, unpinned) => {
		const fetchImpl = vi.fn(cdn())
		await expect(prepareCrs(unpinned, fresh(), { fetchImpl, decompress: async () => {} })).rejects.toThrow(/not a sha256/)
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it("refuses a decompressed G1 that does not match its pin", async () => {
		const decompress = async (dir: string) => writeFileSync(join(dir, "bn254_g1.dat"), Buffer.alloc(128, 5))
		await expect(prepareCrs(pin, fresh(), { fetchImpl: cdn(), decompress })).rejects.toThrow(/decompressed G1/)
	})
})
