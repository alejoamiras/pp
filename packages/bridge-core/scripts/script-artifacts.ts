/**
 * Foundry (EVM) artifact loaders for the operator scripts, resolved from the repo's committed
 * layout relative to THIS module — every script consumer sees the same `contracts/bridge/evm/out`
 * regardless of its own location. L2 (nargo) artifacts come from `../src/artifacts` instead;
 * these are the L1 side only.
 */
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Abi } from "viem"

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "bridge", "evm", "out")

export function evmArtifact(name: string): { abi: Abi; bytecode: `0x${string}` } {
	const j = JSON.parse(readFileSync(join(OUT, `${name}.sol`, `${name}.json`), "utf8"))
	return { abi: j.abi as Abi, bytecode: j.bytecode.object as `0x${string}` }
}

export function evmAbi(name: string): Abi {
	return JSON.parse(readFileSync(join(OUT, `${name}.sol`, `${name}.json`), "utf8")).abi as Abi
}

/** The artifacts among `names` that `forge build` has not produced, as paths. */
export function missingEvmArtifacts(names: readonly string[]): string[] {
	return names.map((name) => join(OUT, `${name}.sol`, `${name}.json`)).filter((path) => !existsSync(path))
}
