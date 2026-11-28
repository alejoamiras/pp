import { readFileSync } from "node:fs"
import { join } from "node:path"
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

/**
 * A contract's creation code at the pinned build: the hash without metadata, and the full size with it.
 * The compiled constructor reads its arguments from that size, so a creation input splits there.
 */
export type CreationPin = { hash: Hex; size: number }

/** The pin of every contract a keyed run broadcasts. */
export const CREATION_CODES = JSON.parse(readFileSync(fileURLToPath(new URL("../creation-codes.json", import.meta.url)), "utf8")) as Record<
	"PortalFactory",
	CreationPin
>

const FORGE_OUT = fileURLToPath(new URL("../../../contracts/bridge/evm/out/", import.meta.url))

/** The forge artifact for `name` under `out`; by default the one `@pp/bridge-core`'s deploy loads. */
export const forgeArtifact = (name: string, out = FORGE_OUT): string => join(out, `${name}.sol`, `${name}.json`)

/**
 * The build directory `deploy`'s check reads: a `--rehearse` run's own copy when `PP_TESTNET_FORGE_OUT`
 * names one, so a rehearsal never rewrites the shared build; every other mode reads the checkout's.
 */
export const checkedForgeOut = (mode: { kind: string }, env: NodeJS.ProcessEnv, checkout = FORGE_OUT): string =>
	(mode.kind === "rehearse" && env.PP_TESTNET_FORGE_OUT) || checkout

/**
 * `deploy`'s build check: {@link checkedForgeOut}'s build, then the checkout's, which is the one
 * `@pp/bridge-core` broadcasts, so a rehearsal's copy can fail the check but never stand in for it.
 * @returns the first mismatch, or undefined
 */
export const deployBuildMismatch = (mode: { kind: string }, env: NodeJS.ProcessEnv, checkout = FORGE_OUT): string | undefined =>
	buildMismatch(checkedForgeOut(mode, env, checkout)) ?? buildMismatch(checkout)

/**
 * Every contract in {@link CREATION_CODES}, as the deploy will load it, matches its pin's hash and size.
 * @returns the first mismatch as `name: actual, committed pin`, or undefined
 */
export function buildMismatch(out = FORGE_OUT): string | undefined {
	for (const [name, want] of Object.entries(CREATION_CODES)) {
		let actual: string
		try {
			const code = JSON.parse(readFileSync(forgeArtifact(name, out), "utf8")).bytecode.object as Hex
			actual = `${creationCodeHash(code)} (${size(code)} bytes)`
		} catch (e) {
			actual = `unreadable (${e instanceof Error ? e.message : String(e)})`
		}
		const committed = `${want.hash} (${want.size} bytes)`
		if (actual !== committed) return `${name}: ${actual}, committed ${committed}`
	}
	return undefined
}
