import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { type Hex, hexToNumber, keccak256, size, slice } from "viem"

/**
 * Creation code without solc's trailing CBOR metadata, whose length is the code's last two bytes: the
 * metadata hashes the build's paths and settings, not what the code does. Nested contracts keep theirs.
 * @throws Error when the length suffix overruns the code
 */
export function stripMetadata(code: Hex): Hex {
	const n = size(code)
	if (n < 2) throw new Error("creation code shorter than its metadata length suffix")
	const meta = hexToNumber(slice(code, n - 2))
	if (meta + 2 > n) throw new Error(`metadata length ${meta} overruns ${n} bytes of creation code`)
	return slice(code, 0, n - meta - 2)
}

export const creationCodeHash = (code: Hex): Hex => keccak256(stripMetadata(code))

/** The creation-code hash of every contract a keyed run broadcasts, at the pinned build. */
export const CREATION_CODES = JSON.parse(readFileSync(fileURLToPath(new URL("../creation-codes.json", import.meta.url)), "utf8")) as Record<
	"PortalFactory",
	Hex
>

/** The forge artifact `@pp/bridge-core`'s deploy loads for `name`. */
export const forgeArtifact = (name: string): string =>
	fileURLToPath(new URL(`../../../contracts/bridge/evm/out/${name}.sol/${name}.json`, import.meta.url))

/**
 * Every contract in {@link CREATION_CODES}, as the deploy will load it, hashes to the committed value.
 * @returns the first mismatch as `name: actual`, or undefined
 */
export function buildMismatch(): string | undefined {
	for (const [name, want] of Object.entries(CREATION_CODES)) {
		let actual: string
		try {
			actual = creationCodeHash(JSON.parse(readFileSync(forgeArtifact(name), "utf8")).bytecode.object as Hex)
		} catch (e) {
			actual = `unreadable (${e instanceof Error ? e.message : String(e)})`
		}
		if (actual !== want) return `${name}: ${actual}, committed ${want}`
	}
	return undefined
}
