#!/usr/bin/env bun
// bun run --cwd packages/testnet rehearse [fork | send-faults | pool1 | stack | canary-failures | pause]
// bun run --cwd packages/testnet rehearse pool1 --list   (its step count; loads no part)
// Rehearses the testnet commands, never against a live network and never with the key file. Part `fork`
// runs on an anvil fork of Sepolia this run owns, with keys generated into a scratch home; part
// `send-faults` runs `fund` and `deploy-pool` on such a fork through fronts that inject send faults; part
// `pool1` runs the operator target's `fund`, `verify-deployment` and `seed` cases on such a fork, its ASP
// requests recorded at a loopback front to a stand-in. Parts `stack`
// and `canary-failures` run on the local stack at `PP_STACK_MANIFEST`, or boot one through bridge-core's
// with-stack, which stops it and checks it left nothing behind. Part `pause` runs the guardian's failure
// and recovery cases on bare local anvils with anvil's well-known keys.
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { OPERATOR_FORK_STEPS } from "../src/rehearse/operator-steps"

type Part = (log: (line: string) => void) => Promise<object>

const manifest = process.env.PP_STACK_MANIFEST
const ON_STACK = new Set(["stack", "canary-failures"])
// Loaded on demand: every part but `pause` imports pp-env's entries, which need the pool checkout.
const PARTS: Record<string, () => Promise<Part>> = {
	fork: async () => (await import("../src/rehearse/fork")).forkRehearsal,
	"send-faults": async () => (await import("../src/rehearse/send-faults")).sendFaultsRehearsal,
	pool1: async () => {
		const { operatorForkRehearsal } = await import("../src/rehearse/operator-fork")
		return (log) => operatorForkRehearsal("pool1", log)
	},
	stack: async () => {
		const { stackRehearsal } = await import("../src/rehearse/stack")
		return (log) => stackRehearsal(manifest as string, log)
	},
	"canary-failures": async () => {
		const { canaryFailuresRehearsal } = await import("../src/rehearse/canary-failures")
		return (log) => canaryFailuresRehearsal(manifest as string, log)
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
// The nightly's pull-request count check reads this without the pool checkout.
if (process.argv[3] === "--list") {
	if (part !== "pool1" || process.argv.length > 4) {
		console.error("usage: rehearse pool1 --list")
		process.exit(2)
	}
	console.log(`rehearse ${part}: ${OPERATOR_FORK_STEPS.length} steps listed`)
	process.exit(0)
}
if (process.env.SEED !== undefined) {
	console.error("refused: SEED is set, which makes Aztec's randomness predictable; unset it")
	process.exit(2)
}
if (ON_STACK.has(part) && !manifest) {
	const withStack = join(dirname(fileURLToPath(import.meta.resolve("@pp/bridge-core"))), "..", "scripts", "with-stack.ts")
	// with-stack runs each argument as one `sh -c` command.
	const command = `'${process.execPath}' '${fileURLToPath(import.meta.url)}' ${part}`
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
