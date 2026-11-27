#!/usr/bin/env bun
// bun run --cwd packages/testnet rehearse [fork]
// Rehearses the testnet commands with real proofs, never against a live network and never with the key
// file: part `fork` runs on an anvil fork of Sepolia this run owns, with keys generated into a scratch home.
import { forkRehearsal } from "../src/rehearse/fork"

const bigints = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v)
const part = process.argv[2] ?? "fork"
if (part !== "fork") {
	console.error(`unknown part ${part}; parts: fork`)
	process.exit(2)
}
if (process.env.SEED !== undefined) {
	console.error("refused: SEED is set, which makes Aztec's randomness predictable; unset it")
	process.exit(2)
}
try {
	const result = await forkRehearsal((line) => console.log(line))
	console.log(JSON.stringify({ event: "rehearsed", part, ...result }, bigints))
	process.exit(0)
} catch (e) {
	console.error(`[rehearse] ${part} failed: ${e instanceof Error ? e.message : String(e)}`)
	process.exit(1)
}
