#!/usr/bin/env bun
// bun run --cwd packages/testnet rehearse [fork|stack]
// Rehearses the testnet commands with real proofs, never against a live network and never with the key
// file. Part `fork` runs on an anvil fork of Sepolia this run owns, with keys generated into a scratch
// home. Part `stack` runs on the local stack at `PP_STACK_MANIFEST`, or boots one through bridge-core's
// with-stack, which stops it and checks it left nothing behind.
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { forkRehearsal } from "../src/rehearse/fork"
import { stackRehearsal } from "../src/rehearse/stack"

const bigints = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v)
const PARTS = ["fork", "stack"]
const part = process.argv[2] ?? "fork"
if (!PARTS.includes(part)) {
	console.error(`unknown part ${part}; parts: ${PARTS.join(", ")}`)
	process.exit(2)
}
if (process.env.SEED !== undefined) {
	console.error("refused: SEED is set, which makes Aztec's randomness predictable; unset it")
	process.exit(2)
}
const manifest = process.env.PP_STACK_MANIFEST
if (part === "stack" && !manifest) {
	const withStack = join(dirname(fileURLToPath(import.meta.resolve("@pp/bridge-core"))), "..", "scripts", "with-stack.ts")
	// with-stack runs each argument as one `sh -c` command.
	const command = `'${process.execPath}' '${fileURLToPath(import.meta.url)}' stack`
	const run = spawnSync(process.execPath, [withStack, command], { stdio: "inherit" })
	process.exit(run.status ?? 1)
}
try {
	const log = (line: string) => console.log(line)
	const result = part === "fork" ? await forkRehearsal(log) : await stackRehearsal(manifest as string, log)
	console.log(JSON.stringify({ event: "rehearsed", part, ...result }, bigints))
	process.exit(0)
} catch (e) {
	console.error(`[rehearse] ${part} failed: ${e instanceof Error ? e.message : String(e)}`)
	process.exit(1)
}
