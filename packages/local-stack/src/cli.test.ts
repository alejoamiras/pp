import { describe, expect, test } from "bun:test"
import { type CliDeps, type CliStack, runCli } from "./cli.ts"

function harness(start: CliDeps["startStack"]) {
	const lines: string[] = []
	let fire: (signal: string) => void = () => {}
	const deps: CliDeps = {
		startStack: start,
		newRunId: () => "stack-1-test",
		env: {},
		log: (l) => lines.push(l),
		error: (l) => lines.push(l),
		onSignal: (h) => {
			fire = h
		},
	}
	return { deps, lines, signal: (s: string) => fire(s) }
}

const fakeStack = (stopped: string[]): CliStack => ({
	manifestPath: "/runs/stack-1-test/manifest.json",
	manifest: { l1Rpc: "http://127.0.0.1:1", aztecNode: "http://127.0.0.1:2" },
	stop: async () => {
		stopped.push("stop")
	},
})

describe("demo CLI", () => {
	test("bad arguments and set attach variables exit 2 before anything starts", async () => {
		const h = harness(() => Promise.reject(new Error("must not start")))
		expect(await runCli(["demo", "--kep"], h.deps)).toBe(2)
		expect(await runCli([], h.deps)).toBe(2)
		expect(await runCli(["demo"], { ...h.deps, env: { SANDBOX_L1_RPC: "http://127.0.0.1:8545" } })).toBe(2)
		expect(h.lines.at(-1)).toContain("unset SANDBOX_L1_RPC SANDBOX_NODE_URL")
	})

	test("a failed boot exits 1; a boot stopped by a signal exits 130", async () => {
		expect(await runCli(["demo"], harness(() => Promise.reject(new Error("forge failed"))).deps)).toBe(1)
		const h = harness(async ({ signal }) => {
			h.signal("SIGINT")
			h.signal("SIGTERM")
			expect(signal.aborted).toBe(true)
			throw signal.reason
		})
		expect(await runCli(["demo"], h.deps)).toBe(130)
		expect(h.lines.filter((l) => l.includes("stopping once the current step returns"))).toHaveLength(2)
	})

	test("without --keep it prints the ready lines, tears down and exits 0", async () => {
		const stopped: string[] = []
		const h = harness(async ({ onStep }) => {
			onStep({ step: "network", seconds: 40.51 })
			return fakeStack(stopped)
		})
		expect(await runCli(["demo"], h.deps)).toBe(0)
		expect(stopped).toEqual(["stop"])
		expect(h.lines[0]).toBe(`[stack] run stack-1-test pid ${process.pid}`)
		expect(h.lines).toContain("[stack] network up in 40.5 s")
		expect(h.lines.some((l) => l.endsWith("PP_STACK_MANIFEST=/runs/stack-1-test/manifest.json"))).toBe(true)
		expect(h.lines.at(-1)).toBe("SANDBOX_L1_RPC=http://127.0.0.1:1 SANDBOX_NODE_URL=http://127.0.0.1:2")
	})

	test("with --keep it holds until a signal, then tears down and exits 130", async () => {
		const stopped: string[] = []
		const h = harness(async () => fakeStack(stopped))
		const run = runCli(["demo", "--keep"], h.deps)
		await Bun.sleep(10)
		expect(stopped).toEqual([])
		h.signal("SIGHUP")
		expect(await run).toBe(130)
		expect(stopped).toEqual(["stop"])
	})
})
