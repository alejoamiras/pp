// Against the live endpoint in SEPOLIA_RPC_URL: one owned fork, every pin checked, nothing left behind.
import { describe, expect, test } from "bun:test"
import { PINS, type Pins } from "../src/pins.ts"
import { PreflightError } from "../src/preflight.ts"
import { runFork } from "../src/run.ts"

const endpoint = process.env.SEPOLIA_RPC_URL || undefined
delete process.env.SEPOLIA_RPC_URL

const lines: string[] = []
const log = (line: string) => {
	lines.push(line)
	process.stderr.write(`sepolia-fork: ${line}\n`)
}

const failure = async (pins: Pins) => {
	const err = await runFork({ endpoint: endpoint!, pins, log }).then(
		() => undefined,
		(e: unknown) => e,
	)
	expect(err).toBeInstanceOf(PreflightError)
	return err as PreflightError
}

describe.skipIf(!endpoint)("the Sepolia fork", () => {
	test("starts at the pinned block, holds every pin, and tears down to nothing", async () => {
		const seen: string[] = []
		const report = await runFork({
			endpoint: endpoint!,
			log,
			body: async (fork) => {
				seen.push(await fork.rpc<string>("web3_clientVersion"))
			},
		})
		expect(seen).toEqual(["anvil/v1.7.1"])
		expect(report.finalized).toBeGreaterThan(PINS.block.number)
		expect(report.leftovers).toEqual({ groups: 0, rows: 0, dirs: 0 })
		expect(lines.join("\n")).not.toContain(new URL(endpoint!).pathname.length > 1 ? new URL(endpoint!).pathname : "\0")
	})

	test("a mutated Inbox pin fails on the fork, naming the pin", async () => {
		const err = await failure({ ...PINS, bindings: { ...PINS.bindings, inbox: "0x0000000000000000000000000000000000000001" } })
		expect([err.kind, err.pins]).toEqual(["pin", ["inbox"]])
		expect(lines.at(-1)).toBe("teardown: groups=0 rows=0 dirs=0")
	})

	test("a mutated block hash fails before anything forks, naming the pin", async () => {
		const err = await failure({ ...PINS, block: { ...PINS.block, hash: `0x${"00".repeat(32)}` } })
		expect([err.kind, err.pins]).toEqual(["pin", ["block.hash"]])
		expect(lines.at(-1)).toBe("teardown: groups=0 rows=0 dirs=0")
	})
})
