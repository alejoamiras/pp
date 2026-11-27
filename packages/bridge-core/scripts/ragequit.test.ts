import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { serializeStackManifest } from "../src/stack-manifest"
import { manifest } from "../src/test/client-fakes"
import { type BurnIo, burnLabel, keysFrom, main, parseRagequitArgs } from "./ragequit"

const dir = mkdtempSync(join(tmpdir(), "ragequit-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function manifestFile(name: string, chainId: number, rpc = "http://127.0.0.1:8545"): string {
	const path = join(dir, name)
	writeFileSync(
		path,
		serializeStackManifest({ ...manifest(), chainId, l1Rpc: rpc, aztecNode: rpc, pool: { ...manifest().pool, aspApiUrl: rpc } }),
	)
	return path
}

const KEY = `0x${"ab".repeat(32)}`
const PAYEE = "0x000000000000000000000000000000000000bEEF"

describe("ragequit arguments", () => {
	it("takes --settle-only with a payee and nothing else", () => {
		expect(parseRagequitArgs(["--settle-only", "--payee", PAYEE.toLowerCase()])).toEqual({ settleOnly: true, payee: PAYEE })
		for (const argv of [
			["--settle-only"],
			["--settle-only", "--payee", PAYEE, "--amount", "10"],
			["--amount", "0"],
			["--amount", "-1"],
			["--to", "x"],
			["10"],
		])
			expect(() => parseRagequitArgs(argv), argv.join(" ")).toThrow()
		expect(parseRagequitArgs(["--amount", "10", "--label", "0x2a"])).toMatchObject({ settleOnly: false, amount: 10n, label: 42n })
	})

	it("refuses a key of the wrong shape by its name, never echoing it", () => {
		const short = "0x1234"
		expect(() => keysFrom({ PP_L1_KEY: short, PP_AZTEC_SECRET: KEY }, false)).toThrow(/^PP_L1_KEY must hold a 32-byte hex key$/)
		expect(() => keysFrom({ PP_L1_KEY: KEY }, false)).toThrow(/PP_AZTEC_SECRET/)
		expect(keysFrom({ PP_L1_KEY: KEY }, true)).toEqual({ l1: KEY })
	})

	it.each([
		["a manifest on another chain", () => manifestFile("remote.json", 1, "https://rpc.example")],
		["no manifest", () => undefined],
	])("refuses %s before reading any key", async (_, path) => {
		const read: string[] = []
		const env = new Proxy({ PP_STACK_MANIFEST: path(), PP_L1_KEY: KEY, PP_AZTEC_SECRET: KEY } as Record<string, string | undefined>, {
			get: (t, k: string) => {
				read.push(k)
				return t[k]
			},
		})
		const err = vi.spyOn(console, "error").mockImplementation(() => {})
		expect(await main([], env, () => {})).toBe(2)
		expect(read).toEqual(["PP_STACK_MANIFEST"])
		expect(err.mock.calls.flat().join(" ")).not.toContain(KEY)
		err.mockRestore()
	})
})

describe("burnLabel", () => {
	/** A label's notes, largest first; a burn takes the largest notes summing to its amount. */
	function label(values: bigint[], o: { stale?: number } = {}) {
		let notes = [...values].sort((a, b) => (a > b ? -1 : 1))
		let stale = 0
		const burns: bigint[] = []
		const io: BurnIo = {
			notes: vi.fn(async () => (stale-- > 0 ? [...values] : [...notes])),
			burn: async (amount) => {
				burns.push(amount)
				let taken = 0
				for (let left = amount; left > 0n; taken++) left -= notes[taken] as bigint
				notes = notes.slice(taken)
				stale = o.stale ?? 0
				return `0x${burns.length}`
			},
			pause: vi.fn(async () => {}),
		}
		return { io, burns }
	}

	it("burns a balance of nine notes as eight then one, re-reading the notes after each burn", async () => {
		const l = label(Array(9).fill(10n))
		expect(await burnLabel(l.io)).toEqual(["0x1", "0x2"])
		expect(l.burns).toEqual([80n, 10n])
		expect(l.io.notes).toHaveBeenCalledTimes(3)
	})

	it("burns nothing for an amount no descending prefix makes, or for an empty label", async () => {
		const inexact = label([10n, 6n, 4n])
		await expect(burnLabel(inexact.io, 6n)).rejects.toMatchObject({ code: "NO_EXACT_CHUNKS" })
		expect(inexact.burns).toEqual([])
		await expect(burnLabel(label([]).io)).rejects.toMatchObject({ code: "NOTE_NOT_FOUND" })
	})

	it("waits out a wallet whose notes trail a confirmed burn, and reports one that never shows it", async () => {
		const lagging = label([10n, 10n], { stale: 2 })
		expect(await burnLabel(lagging.io, 10n)).toEqual(["0x1"])
		expect(lagging.io.pause).toHaveBeenCalledTimes(2)
		await expect(burnLabel(label([10n, 10n], { stale: 99 }).io, 10n)).rejects.toMatchObject({ code: "RPC_INCONSISTENT" })
	})
})
