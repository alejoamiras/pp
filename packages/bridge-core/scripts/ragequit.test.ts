import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { toHex } from "viem"
import { afterAll, describe, expect, it, vi } from "vitest"
import { BridgeClientError } from "../src/client/errors"
import type { ExitTicket } from "../src/client/types"
import { serializeStackManifest } from "../src/stack-manifest"
import { manifest } from "../src/test/client-fakes"
import { type BurnIo, burnLabel, keysFrom, main, parseRagequitArgs, reason, ticketsOfBurns } from "./ragequit"

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

	it("refuses a key of the wrong shape or out of its curve's range by its name, never echoing it", () => {
		const word = (v: bigint) => toHex(v, { size: 32 })
		const secp256k1Order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
		for (const bad of ["0x1234", word(0n), word(secp256k1Order), word(2n ** 256n - 1n)])
			expect(() => keysFrom({ PP_L1_KEY: bad, PP_AZTEC_SECRET: KEY }, false), bad).toThrow(
				/^PP_L1_KEY must hold a valid 32-byte hex key$/,
			)
		for (const bad of [word(Fr.MODULUS), word(2n ** 256n - 1n)])
			expect(() => keysFrom({ PP_L1_KEY: KEY, PP_AZTEC_SECRET: bad }, false), bad).toThrow(
				/^PP_AZTEC_SECRET must hold a valid 32-byte hex key$/,
			)
		expect(() => keysFrom({ PP_L1_KEY: KEY }, false)).toThrow(/PP_AZTEC_SECRET/)
		expect(keysFrom({ PP_L1_KEY: KEY }, true)).toEqual({ l1: KEY })
		expect(keysFrom({ PP_L1_KEY: KEY, PP_AZTEC_SECRET: word(Fr.MODULUS - 1n) }, false).aztec).toBe(word(Fr.MODULUS - 1n))
	})

	it("prints a lower layer's error by name once keys are loaded, and an uncertain settle with its L1 hash", () => {
		const leaky = new TypeError(`invalid scalar ${BigInt(KEY)} from ${KEY}`)
		expect(reason(leaky, false)).toBe("TypeError")
		expect(reason(leaky, true)).toContain("invalid scalar")
		const hash = `0x${"cd".repeat(32)}` as const
		expect(reason(new BridgeClientError("UNCERTAIN", { l1TxHash: hash }), false)).toBe(`UNCERTAIN in L1 tx ${hash}`)
		expect(reason(new BridgeClientError("RPC_FAILED", { source: "HttpRequestError" }), false)).toBe("RPC_FAILED (HttpRequestError)")
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

	it.each<[string, () => Promise<readonly number[]>, number]>([
		["an L1 RPC on another chain", async () => [1, 31337], 2],
		["a node following another chain", async () => [31337, 1], 2],
		["an unreachable RPC", async () => Promise.reject(new Error("connection refused")), 1],
	])("refuses %s behind a local manifest before reading any key", async (_, chains, code) => {
		const read: string[] = []
		const env = new Proxy(
			{ PP_STACK_MANIFEST: manifestFile("local.json", 31337), PP_L1_KEY: KEY } as Record<string, string | undefined>,
			{
				get: (t, k: string) => {
					read.push(k)
					return t[k]
				},
			},
		)
		const err = vi.spyOn(console, "error").mockImplementation(() => {})
		expect(await main([], env, () => {}, chains)).toBe(code)
		expect(read).toEqual(["PP_STACK_MANIFEST"])
		err.mockRestore()
	})
})

describe("ticketsOfBurns", () => {
	const ticket = (tx: string, amount: bigint, label = 5n): ExitTicket => ({
		kind: "ragequit",
		token: "0x07",
		payee: PAYEE,
		amount,
		label,
		l2TxHash: tx as `0x${string}`,
		messageIndexInTx: 0,
	})
	const burns = [
		{ tx: "0xA1", amount: 80n },
		{ tx: "0xa2", amount: 10n },
	]

	it("reads again until every burn shows its ticket, and returns them in burn order", async () => {
		const reads = [[ticket("0xa1", 80n)], [ticket("0xa2", 10n), ticket("0xa1", 80n), ticket("0xb0", 3n)]]
		const pause = vi.fn(async () => {})
		const out = await ticketsOfBurns(async () => reads.shift() ?? [], burns, 5n, pause)
		expect(out.map((t) => t.l2TxHash)).toEqual(["0xa1", "0xa2"])
		expect(pause).toHaveBeenCalledOnce()
	})

	it("reads again after a failed read, and fails with the last one when every read fails", async () => {
		const reads: (() => Promise<ExitTicket[]>)[] = [
			async () => Promise.reject(new Error("connection reset")),
			async () => [ticket("0xa1", 80n), ticket("0xa2", 10n)],
		]
		const pause = vi.fn(async () => {})
		expect(await ticketsOfBurns(() => (reads.shift() as () => Promise<ExitTicket[]>)(), burns, 5n, pause)).toHaveLength(2)
		expect(pause).toHaveBeenCalledOnce()
		const down = async () => Promise.reject(new Error("connection refused"))
		await expect(ticketsOfBurns(down, burns, 5n, pause, 3)).rejects.toThrow("connection refused")
	})

	it("fails naming a burn that never shows a ticket, and at once on a ticket the burn did not make", async () => {
		const pause = vi.fn(async () => {})
		await expect(ticketsOfBurns(async () => [ticket("0xa1", 80n)], burns, 5n, pause, 3)).rejects.toThrow(
			"no ticket shows for L2 tx 0xa2",
		)
		expect(pause).toHaveBeenCalledTimes(2)
		for (const wrong of [ticket("0xa2", 11n), ticket("0xa2", 10n, 6n)])
			await expect(ticketsOfBurns(async () => [ticket("0xa1", 80n), wrong], burns, 5n, pause)).rejects.toMatchObject({
				code: "RPC_INCONSISTENT",
			})
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
