/**
 * Generates `contracts/bridge/evm/remappings.txt`, whose `@aztec/` and
 * `@aztec-blob-lib/` remaps reach THIS workspace's declared
 * `@aztec-foundation/l1-artifacts` dependency through a link the script places
 * inside the Foundry root, at `contracts/bridge/evm/node_modules/` (gitignored).
 *
 * Why generated: `foundry.toml`'s static `../../../node_modules/...` remaps
 * assume the hoisted node_modules layout. Foundry gives `remappings.txt`
 * priority over the TOML remappings, so the generated file keeps `forge`
 * working under BOTH linkers. The layout-independent remaps are repeated so the
 * override file is complete — Foundry treats remappings.txt as the full set.
 *
 * Run before any forge invocation in `contracts/bridge/evm`:
 * `bun scripts/gen-remappings.ts` from packages/bridge-core. Only CI and the
 * sandbox's forge step run it for you.
 */
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { resolvePackageAsset, resolvePackageRoot } from "@nulo-sh/resolve-asset"
import { run } from "./run"

const here = dirname(fileURLToPath(import.meta.url))
export const EVM_ROOT = join(here, "..", "..", "..", "contracts", "bridge", "evm")

// Forge names every source outside its root by absolute path (relative imports inside a remapped
// tree too), and solc hashes those names into each contract's metadata and so into its bytecode; a
// link inside the root, which forge does not resolve, keeps every name root-relative.
const LINK = "node_modules/@aztec-foundation/l1-artifacts"
/** The `@aztec/` target, relative to the Foundry root. */
export const AZTEC_SRC = `${LINK}/l1-contracts/src/`

/** Points the in-root link at the package bridge-core resolves; atomic, so concurrent runs agree. */
function linkL1Artifacts(): void {
	const from = import.meta.url
	// Throws, before the link moves, when the package or its sources are missing.
	resolvePackageAsset("@aztec-foundation/l1-artifacts", "l1-contracts/src", { from })
	const link = join(EVM_ROOT, LINK)
	mkdirSync(dirname(link), { recursive: true })
	const tmp = `${link}.${process.pid}.tmp`
	rmSync(tmp, { force: true })
	symlinkSync(relative(dirname(link), resolvePackageRoot("@aztec-foundation/l1-artifacts", { from })), tmp)
	renameSync(tmp, link)
}

export function generateRemappings(): string {
	linkL1Artifacts()
	const lines = [
		"@oz/=lib/openzeppelin-contracts/contracts/",
		`@aztec/=${AZTEC_SRC}`,
		// FeeLib/ProposeLib import BlobLib through this alias rather than a relative
		// path, so it must resolve to the same tree as @aztec/ or the upstream portal
		// fails to compile under the isolated linker.
		`@aztec-blob-lib/=${AZTEC_SRC}core/libraries/rollup/`,
		"@test/=test/",
		"forge-std/=lib/forge-std/src/",
	]
	const target = join(EVM_ROOT, "remappings.txt")
	// Per-process temp name: concurrent verify runs must not rename each other's file.
	const tmp = `${target}.${process.pid}.tmp`
	writeFileSync(tmp, `${lines.join("\n")}\n`)
	renameSync(tmp, target)
	return target
}

/** Asserts forge actually sees the generated `@aztec/` mapping (and records the forge version). */
export function assertEffectiveRemapping(forgeBin: string): void {
	const version = run(forgeBin, ["--version"], { check: false })
	if (version.code !== undefined || version.exitCode !== 0) {
		throw new Error(`forge not runnable at ${forgeBin}: ${version.code ?? version.stderr}`)
	}
	const remaps = run(forgeBin, ["remappings"], { cwd: EVM_ROOT, check: false })
	if (remaps.code !== undefined || remaps.exitCode !== 0) {
		throw new Error(`forge remappings failed: ${remaps.code ?? remaps.stderr}`)
	}
	// Both aliases are asserted: checking only @aztec/ let a stale hoisted-layout
	// @aztec-blob-lib/ pass this gate and fail at compile time instead.
	const effective = remaps.stdout.split("\n")
	for (const [prefix, target] of [
		["@aztec/", AZTEC_SRC],
		["@aztec-blob-lib/", `${AZTEC_SRC}core/libraries/rollup/`],
	]) {
		const line = effective.find((l) => l.startsWith(`${prefix}=`))
		// Exact-line equality: a substring match would accept `${target}extra/` and
		// defeat the stale/unexpected-target rejection this assertion exists for.
		if (line?.trim() !== `${prefix}=${target}`) {
			throw new Error(
				`forge (${version.stdout.split("\n")[0]}) does not see the generated ${prefix} remap.\n` +
					`effective: ${line ?? "<none>"}\nexpected: ${target}`,
			)
		}
	}
	console.log(`remappings OK — ${version.stdout.split("\n")[0]} sees @aztec/=${AZTEC_SRC}`)
}

const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false
if (isMain) {
	const target = generateRemappings()
	console.log(`wrote ${target}`)
	if (!existsSync(join(EVM_ROOT, "lib", "forge-std"))) {
		console.warn("note: contracts/bridge/evm/lib is not populated — forge assertions skipped")
	}
}
