#!/usr/bin/env bun
// bun run --cwd packages/testnet rehearse [fork | stack | pause]
// Rehearses the testnet commands, never against a live network and never with the key file. Part `fork`
// runs on an anvil fork of Sepolia this run owns, with keys generated into a scratch home. Part `stack`
// runs on the local stack at `PP_STACK_MANIFEST`, or boots one through bridge-core's with-stack, which
// stops it and checks it left nothing behind. Part `pause` runs the guardian's failure and recovery cases
// on bare local anvils with anvil's well-known keys.
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

type Part = (log: (line: string) => void) => Promise<object>

const manifest = process.env.PP_STACK_MANIFEST
// Loaded on demand: parts `fork` and `stack` import pp-env's entries, which need the pool checkout; `pause` does not.
const PARTS: Record<string, () => Promise<Part>> = {
	fork: async () => (await import("../src/rehearse/fork")).forkRehearsal,
	stack: async () => {
		const { stackRehearsal } = await import("../src/rehearse/stack")
		return (log) => stackRehearsal(manifest as string, log)
	},
	pause: async () => (await import("../src/rehearse/pause")).pauseRehearsal,
}

const bigints = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v)
const part = process.argv[2] ?? "fork"
const load = PARTS[part]
if (!load) {
	console.error(`unknown part ${part}; parts: ${Object.keys(PARTS).join(", ")}`)
	process.exit(2)
}
if (process.env.SEED !== undefined) {
	console.error("refused: SEED is set, which makes Aztec's randomness predictable; unset it")
	process.exit(2)
}
if (part === "stack" && !manifest) {
	const withStack = join(dirname(fileURLToPath(import.meta.resolve("@pp/bridge-core"))), "..", "scripts", "with-stack.ts")
	// with-stack runs each argument as one `sh -c` command.
	const command = `'${process.execPath}' '${fileURLToPath(import.meta.url)}' stack`
	const run = spawnSync(process.execPath, [withStack, command], { stdio: "inherit" })
	process.exit(run.status ?? 1)
}
try {
	const result = await (await load())((line) => console.log(line))
	console.log(JSON.stringify({ event: "rehearsed", part, ...result }, bigints))
	process.exit(0)
} catch (e) {
	console.error(`[rehearse] ${part} failed: ${e instanceof Error ? e.message : String(e)}`)
	process.exit(1)
}
