// A snarkjs Groth16 verifier embeds its verification key as code constants, so the deployed verifier
// accepts the bundle's proofs only if its code carries every coordinate of the bundle's key.
import type { Hex } from "viem"

export type Vkey = {
	vk_alpha_1: readonly string[]
	vk_beta_2: readonly (readonly string[])[]
	vk_gamma_2: readonly (readonly string[])[]
	vk_delta_2: readonly (readonly string[])[]
	IC: readonly (readonly string[])[]
}

/**
 * Every constant pushed by a PUSH of 20 bytes or more, as 32 bytes. Opcodes are walked so push data never
 * reads as an opcode; solc shortens a constant with leading zero bytes, hence the left padding.
 */
export function pushedWords(code: Hex): Set<string> {
	const bytes = Buffer.from(code.slice(2), "hex")
	const out = new Set<string>()
	for (let i = 0; i < bytes.length; i++) {
		const op = bytes[i] ?? 0
		if (op < 0x60 || op > 0x7f) continue
		const n = op - 0x5f
		if (n >= 20)
			out.add(
				bytes
					.subarray(i + 1, i + 1 + n)
					.toString("hex")
					.padStart(64, "0"),
			)
		i += n
	}
	return out
}

const word = (decimal: string) => BigInt(decimal).toString(16).padStart(64, "0")

/** Each affine coordinate of the key, named; the projective z (always 1) is left out. */
export function keyCoordinates(vk: Vkey): { name: string; word: string }[] {
	const g1 = (name: string, p: readonly string[]) => p.slice(0, 2).map((c, i) => ({ name: `${name}.${"xy"[i]}`, word: word(c) }))
	const g2 = (name: string, p: readonly (readonly string[])[]) =>
		p.slice(0, 2).flatMap((pair, i) => pair.map((c, j) => ({ name: `${name}.${"xy"[i]}${j}`, word: word(c) })))
	return [
		...g1("alpha1", vk.vk_alpha_1),
		...g2("beta2", vk.vk_beta_2),
		...g2("gamma2", vk.vk_gamma_2),
		...g2("delta2", vk.vk_delta_2),
		...vk.IC.flatMap((p, i) => g1(`IC${i}`, p)),
	]
}

/** The coordinates of `vk` that `code` does not carry; empty when the verifier holds the key. */
export function missingKeyPoints(code: Hex, vk: Vkey): string[] {
	const words = pushedWords(code)
	return keyCoordinates(vk)
		.filter((c) => !words.has(c.word))
		.map((c) => c.name)
}
