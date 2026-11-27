import { expect, test } from "bun:test"
import type { Hex } from "viem"
import { keyCoordinates, missingKeyPoints, type Vkey } from "./keys.ts"
import { PINS } from "./pins.ts"
import { checkKeys, PreflightError } from "./preflight.ts"
import type { Rpc } from "./rpc.ts"

const VK: Vkey = {
	vk_alpha_1: ["11", "12", "1"],
	vk_beta_2: [
		["21", "22"],
		["23", "24"],
		["1", "0"],
	],
	vk_gamma_2: [
		["31", "32"],
		["33", "34"],
		["1", "0"],
	],
	vk_delta_2: [
		["41", "42"],
		["43", "44"],
		["1", "0"],
	],
	// A coordinate whose top byte is zero, which solc pushes with PUSH31.
	IC: [
		["51", (2n ** 240n + 7n).toString()],
		["53", "54", "1"],
	],
}

/** Verifier-shaped code: each coordinate pushed as solc would, between unrelated opcodes. */
function code(vk: Vkey, skip?: string): Hex {
	let out = "6080604052"
	for (const c of keyCoordinates(vk)) {
		if (c.name === skip) continue
		const trimmed = c.word.replace(/^(00)+/, "")
		const n = trimmed.length / 2
		out += `${n >= 20 ? `${(0x5f + n).toString(16)}${trimmed}` : `7f${c.word}`}50`
	}
	// PUSH1 0x7f: push data that looks like a PUSH32 opcode must not swallow what follows.
	return `0x${out}607f00`
}

test("a verifier holds a key only if its code pushes every affine coordinate, and a missing one is named", () => {
	expect(keyCoordinates(VK)).toHaveLength(2 + 4 * 3 + 2 * 2)
	expect(missingKeyPoints(code(VK), VK)).toEqual([])
	expect(missingKeyPoints(code(VK, "IC0.y"), VK)).toEqual(["IC0.y"])
	expect(missingKeyPoints(code(VK, "delta2.x1"), VK)).toEqual(["delta2.x1"])
})

test("the preflight names the pinned verifier whose code lacks the bundle's key", async () => {
	const codes = new Map<string, Hex>([
		[PINS.bindings.depositVerifier.toLowerCase(), code(VK)],
		[PINS.bindings.transact1x1Verifier.toLowerCase(), code(VK, "IC1.x")],
	])
	const fork: Rpc = async <T>(_method: string, params: unknown[] = []) => codes.get(String(params[0]).toLowerCase()) as T
	await checkKeys(fork, PINS, { deposit: VK, transact_1x1: { ...VK, IC: VK.IC.slice(0, 1) } })
	const err = await checkKeys(fork, PINS, { deposit: VK, transact_1x1: VK }).catch((e: unknown) => e)
	expect(err).toBeInstanceOf(PreflightError)
	expect([(err as PreflightError).kind, (err as PreflightError).pins]).toEqual(["pin", ["transact1x1Verifier.keys"]])
	expect((err as Error).message).toContain("transact1x1Verifier lacks the transact_1x1 key's IC1.x")
})
