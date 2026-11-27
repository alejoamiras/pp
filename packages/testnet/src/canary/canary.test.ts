import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { type ExitTicket, PROCESSOR_PORTAL_ABI } from "@pp/bridge-core"
import { type Address, encodeAbiParameters, encodeEventTopics, type Hex, type Log } from "viem"
import { describe, expect, it } from "vitest"
import { GuardError } from "../guards"
import { scratchHome } from "../test-support"
import { canaryArgs } from "./args"
import { type ExitIo, MAX_FAULTS, nextPoll, type Observation, paysTicket, ticketsOf, waitEpochProof } from "./exits"

const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address
const LIVE = { kind: "live" } as const

describe("canary arguments", () => {
	it("takes a run's sequence and post, or --settle's burn hashes", () => {
		expect(canaryArgs(LIVE, { "min-sequence": "7", post: h(1) }, [])).toEqual({ kind: "run", minSequence: 7n, post: h(1) })
		expect(canaryArgs(LIVE, { settle: true }, [h(2), h(3)])).toEqual({ kind: "settle", burns: [h(2), h(3)] })
	})

	it("refuses, without echoing a value, every malformed or mixed form and a fork", () => {
		const refused: [Parameters<typeof canaryArgs>[1], string[], { kind: string; url?: string }?][] = [
			[{ post: h(1) }, []],
			[{ "min-sequence": "0", post: h(1) }, []],
			[{ "min-sequence": "7", post: "0x1234" }, []],
			[{ "min-sequence": "7", post: h(1) }, [h(2)]],
			[{ settle: true }, []],
			[{ settle: true, post: h(1) }, [h(2)]],
			[{ settle: true }, ["SENTINEL-NOT-A-HASH"]],
			[{ settle: true }, [h(2), h(2).toUpperCase().replace("0X", "0x")]],
			[{ "min-sequence": "7", post: h(1) }, [], { kind: "rehearse-fork", url: "http://127.0.0.1:9545" }],
		]
		for (const [values, rest, mode] of refused) {
			const run = () => canaryArgs((mode ?? LIVE) as never, values, rest)
			expect(run).toThrow(GuardError)
			expect(run).not.toThrow(/SENTINEL|0x1234/)
		}
	})

	it("refuses bad arguments before it loads the file or reads a key", async () => {
		const cli = fileURLToPath(new URL("../cli/canary.ts", import.meta.url))
		const home = scratchHome()
		const out = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
			const child = spawn(process.execPath, [cli, "missing.json", "--settle", "SENTINEL-NOT-A-HASH"], {
				env: { PATH: process.env.PATH, HOME: home },
				stdio: ["ignore", "pipe", "pipe"],
			})
			let text = ""
			child.stdout.on("data", (b) => (text += b))
			child.stderr.on("data", (b) => (text += b))
			child.on("error", reject)
			child.on("close", (code) => resolve({ code, text }))
		})
		expect([out.code, /refused: argv: burn hash 1/.test(out.text), out.text.includes("SENTINEL")]).toEqual([2, true, false])
	}, 60_000)
})

const ticket = (tx: number, o: Partial<{ payee: Address; amount: bigint; label: bigint }> = {}): ExitTicket => ({
	kind: "ragequit",
	token: h(9),
	payee: o.payee ?? a(7),
	amount: o.amount ?? 50n,
	label: o.label ?? 11n,
	l2TxHash: h(tx),
	messageIndexInTx: 0,
})

describe("burns and their tickets", () => {
	it("finds each burn's one ragequit ticket to the payee by hash, and lists burns without one", () => {
		const tickets = [ticket(1), ticket(2, { payee: a(8) }), { ...ticket(3), kind: "public" as const }]
		expect(ticketsOf([{ txHash: h(1), amount: 50n, label: 11n }, { txHash: h(2) }, { txHash: h(3) }], tickets, a(7))).toEqual({
			found: [ticket(1)],
			missing: [h(2), h(3)],
		})
	})

	it("refuses a burn whose transaction shows another amount, another label or two tickets", () => {
		for (const tickets of [[ticket(1, { amount: 49n })], [ticket(1, { label: 12n })], [ticket(1), ticket(1)]])
			expect(() => ticketsOf([{ txHash: h(1), amount: 50n, label: 11n }], tickets, a(7))).toThrow(/RPC_INCONSISTENT/)
	})

	it("accepts a settle only when the portal's ExitSettled pays the ticket's payee, amount and label", () => {
		const portal = a(0x99)
		const log = (o: { address?: Address; payee?: Address; amount?: bigint; label?: bigint }): Log =>
			({
				address: o.address ?? portal,
				topics: encodeEventTopics({
					abi: PROCESSOR_PORTAL_ABI,
					eventName: "ExitSettled",
					args: { payee: o.payee ?? a(7), label: o.label ?? 11n, epoch: 3n },
				}),
				data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [o.amount ?? 50n, 4n]),
			}) as unknown as Log
		expect(paysTicket([log({})], portal, ticket(1))).toBe(true)
		for (const wrong of [{ address: a(0x98) }, { payee: a(8) }, { amount: 49n }, { label: 12n }])
			expect(paysTicket([log(wrong)], portal, ticket(1))).toBe(false)
	})
})

describe("the epoch-proof wait", () => {
	it("times out only on a proving read, and ends after more than MAX_FAULTS failed polls in a row", () => {
		let s = { deadline: 100, faults: 0 }
		const step = (o: Observation, now: number) => {
			const r = nextPoll(s, o, now)
			s = r.state
			return r.verdict
		}
		expect([step("fault", 200), step("missing-effect", 200), step("proving", 50), step("proving", 100)]).toEqual([
			"poll",
			"poll",
			"poll",
			"timeout",
		])
		s = { deadline: 100, faults: 0 }
		const faults = Array.from({ length: MAX_FAULTS + 1 }, () => step("fault", 0))
		expect([faults.slice(0, MAX_FAULTS).every((v) => v === "poll"), faults.at(-1), step("ready", 0)]).toEqual([true, "faults", "ready"])
	})

	it("names a missing effect RPC_EVIDENCE_MISSING and a thrown read READ_FAULT when they end it", async () => {
		const io = (effect: () => Promise<boolean>): ExitIo => ({ effect, status: async () => "proving" })
		const wait = (x: ExitIo) => waitEpochProof(x, ticket(1), { deadline: Date.now() + 60_000, pollMs: 0, log: () => {} })
		await expect(wait(io(async () => false))).rejects.toThrow(/^RPC_EVIDENCE_MISSING/)
		await expect(wait(io(() => Promise.reject(new Error("503"))))).rejects.toThrow(/^READ_FAULT/)
		const ready: ExitIo = { effect: async () => true, status: async () => "ready" }
		await expect(wait(ready)).resolves.toBe("ready")
	})
})
