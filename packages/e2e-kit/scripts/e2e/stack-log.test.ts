import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { runCli } from "@pp/local-stack/cli"
import { expect, test } from "vitest"
import { parseStackLog, untilReady } from "./stack-log"

const USER = "0x000000000000000000000000000000000000000d"
const SENDER = "0x000000000000000000000000000000000000000c"
const MANIFEST = "/runs/pp state/stack-1-test/manifest.json"
const CIRCUITS = "/cache/pp v2/checkout/packages/circuits/build"

/** What local-stack's CLI prints for a boot that succeeds: its own code, over a fake stack. */
async function cliOutput(): Promise<string> {
	const lines: string[] = []
	const code = await runCli(["demo"], {
		startStack: async ({ onStep }) => {
			onStep({ step: "network", seconds: 40.5 })
			return {
				manifestPath: MANIFEST,
				manifest: { l1Rpc: "http://127.0.0.1:1", aztecNode: "http://127.0.0.1:2" },
				seeded: { user: USER, sender: SENDER },
				pool: { clientConfig: { circuitsDir: CIRCUITS } },
				stop: async () => {},
			}
		},
		newRunId: () => "stack-1-test",
		env: {},
		log: (line) => lines.push(line),
		error: (line) => lines.push(line),
		onSignal: () => {},
	})
	expect(code).toBe(0)
	return `${lines.join("\n")}\n`
}

test("the log parser reads the circuits, manifest and seeded accounts from the CLI's own output", async () => {
	expect(parseStackLog(await cliOutput())).toEqual({
		circuitsDir: CIRCUITS,
		manifestPath: MANIFEST,
		seeded: { user: USER, sender: SENDER },
	})
})

test("the wait fails at the ready line without a circuits line, shortly after it without a seeded one, and on a CLI that exited", async () => {
	const base = join(homedir(), ".cache", "pp", "e2e-kit")
	mkdirSync(base, { recursive: true })
	const dir = mkdtempSync(join(base, "stack-log-"))
	try {
		const log = join(dir, "stack.log")
		const full = await cliOutput()
		const wait = () => untilReady(log, () => null, { seededGraceMs: 200, pollMs: 20 })
		writeFileSync(log, full.replace(/^\[stack\] circuits .*\n/m, ""))
		await expect(wait()).rejects.toThrow(/logged ready but no circuits directory/)
		writeFileSync(log, full.replace(/^.*pool user.*$/m, "[stack] pool user (none)"))
		const t0 = Date.now()
		await expect(wait()).rejects.toThrow(/logged ready but no seeded accounts/)
		expect(Date.now() - t0).toBeLessThan(2_000)
		writeFileSync(log, full)
		await expect(untilReady(log, () => 1, { pollMs: 20 })).rejects.toThrow(/exited \(1\) before it was ready/)
		await expect(wait()).resolves.toEqual({ circuitsDir: CIRCUITS, manifestPath: MANIFEST, user: USER, sender: SENDER })
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})
