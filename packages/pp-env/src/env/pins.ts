// Everything the fetch trusts is pinned here; a changed byte upstream must fail the fetch, not slip through.

export const PPV2_REPO = "0xbow-io/privacy-pools-v2-monorepo"
export const PPV2_COMMIT = "61fac03acd1fc306164ddc234f7fac4147d04493"
/** sha256 of codeload's tar.gz for PPV2_COMMIT. */
export const PPV2_TARBALL_SHA256 = "422019469ff0be63b562672b39497cb9e754d41daf92a43f4bb4f175b9ee3abb"
/** Bump whenever the fetch would produce a different tree, so an old cache is never reused. */
export const FETCH_RECIPE = 1

export const PROVING_CIRCUITS = ["deposit", "transact_1x1"] as const

const TRANSACT_SHAPES = [1, 2, 3, 4, 5].flatMap((n) => [1, 2, 3, 4, 5].map((m) => `transact_${n}x${m}`))
/** PoolVault's initializer takes all 27 verifiers, so all of them must compile. */
export const VERIFIER_CIRCUITS = ["deposit", "ragequit", ...TRANSACT_SHAPES] as const

const BUILD = "packages/circuits/build"

/** Repo-relative paths that are git-LFS pointers in the tarball and must be hydrated. */
export function lfsPaths(): string[] {
	const verifiers = VERIFIER_CIRCUITS.map((c) => `${BUILD}/${c}/groth16_verifier.sol`)
	const proving = PROVING_CIRCUITS.flatMap((c) => [`${BUILD}/${c}/${c}_js/${c}.wasm`, `${BUILD}/${c}/groth16_pkey.zkey`])
	return [...verifiers, ...proving]
}

export function zkeyCircuit(path: string): string | undefined {
	return /circuits\/build\/([a-z0-9_]+)\/groth16_pkey\.zkey$/.exec(path)?.[1]
}

/**
 * Tree digests for the two dependencies upstream's pnpm lockfile pins by URL only
 * (no integrity field), keyed by their path under packages/contracts/node_modules.
 */
export const URL_PINNED_DEPS: Readonly<Record<string, string>> = {
	"forge-std": "53b8fa47e3a775361471a8fa60cdbe6ed42ef8a7fbf2ac275482e0f9901c2483",
	"@safe-global/safe-contracts": "84dc5f865c71399d17bce4a6b117cadc466c3cb39ae779e38e69e8fa59fb2667",
}

/** PoseidonT3/T4 live at fixed CREATE2 addresses on real chains; anvil gets their code via anvil_setCode. */
export const POSEIDON_LIBRARIES = [
	{ name: "PoseidonT3", address: "0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93" },
	{ name: "PoseidonT4", address: "0x4443338EF595F44e0121df4C21102677B142ECF0" },
] as const

export function forgeLibraryFlags(): string[] {
	return POSEIDON_LIBRARIES.flatMap(({ name, address }) => ["--libraries", `poseidon-solidity/${name}.sol:${name}:${address}`])
}

export const CANONICAL_CODE_FIXTURE = "packages/evm-sdk/e2e/fixtures/canonical-code.json"
export const CONTRACTS_DIR = "packages/contracts"
export const CIRCUITS_DIR = BUILD
