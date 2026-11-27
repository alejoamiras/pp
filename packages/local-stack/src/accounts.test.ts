import { readFileSync } from "node:fs"
import { anvilKey, HARNESS_INDEX } from "@pp/bridge-core/sandbox"
import { privateKeyToAccount } from "viem/accounts"
import { expect, test } from "vitest"
import { BRIDGE_DEPLOYER_INDEX, DEMO_SENDER_ADDRESS, DEMO_SENDER_INDEX, POOL_DEPLOYER_INDEX, SEED_USER_INDEX } from "./accounts.ts"

// Node loads this module for the web build's config, in jobs that never fetch the pool checkout: a
// value import here would pull in the sandbox (extensionless imports) or pp-env (the checkout).
test("the module the web build loads imports types only", () => {
	const imports = readFileSync(new URL("./accounts.ts", import.meta.url), "utf8").match(/^import .*$/gm) ?? []
	expect(imports.filter((line) => !line.startsWith("import type "))).toEqual([])
})

test("the plain values equal what they stand for: the demo sender's derived address and the harness index", () => {
	expect(DEMO_SENDER_ADDRESS).toBe(privateKeyToAccount(anvilKey(DEMO_SENDER_INDEX)).address)
	expect(BRIDGE_DEPLOYER_INDEX).toBe(HARNESS_INDEX)
})

/**
 * The demo stack runs no actors, so its L1 signers are {0, 13, 14, 15}: the node, the seeded user, the
 * pool's deployer and postman, and the bridge's deployer, which is the harness. The demo sender races
 * none of them for a nonce. It sits inside the sandbox's default actor range, 1..12, which is harmless:
 * only a local-stack page build carries the demo sender, as `apps/web/scripts/check-stack-build.ts`
 * (`check:stack-build`) proves by finding its sentinel and address in that build and in no other.
 */
test("the demo sender signs from an index no other signer of the stack uses", () => {
	// The local network's block publisher and validator sign from index 0 (bridge-core's
	// `scripts/sandbox/constants.ts`).
	const NODE_INDEX = 0
	const signers = [NODE_INDEX, SEED_USER_INDEX, POOL_DEPLOYER_INDEX, BRIDGE_DEPLOYER_INDEX, HARNESS_INDEX]
	expect(new Set(signers)).toEqual(new Set([0, 13, 14, 15]))
	expect(signers).not.toContain(DEMO_SENDER_INDEX)
})
