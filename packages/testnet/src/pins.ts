/**
 * What a run's inputs are pinned to, beside the bridge's creation code (`creation.ts`): the forge
 * binary, the own pool's creation code in pp-env's fetched build, and the L2 contract class ids.
 * `bun run pins` rewrites the two derived files after a bump; `verify-inputs` checks all of them.
 */
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract"
import { tokenBridgeHubArtifact } from "@pp/bridge-core/artifacts"
import { aspRootRegistryArtifact } from "@pp/bridge-core/asp-registry-artifact"
import { labelledTokenArtifact } from "@pp/labelled-token"
import { type Hex, keccak256 } from "viem"

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const readJson = <T>(path: string): T => JSON.parse(readFileSync(here(path), "utf8")) as T

/** The Foundry 1.7.1 release's linux-x64 forge, the binary CI's foundry-toolchain step installs. */
export const FORGE = readJson<{ version: string; sha256: Record<string, string> }>("../toolchain.json")

export const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex")

/**
 * Every contract the own pool's deploy broadcasts, by `<file>:<name>` in pp-env's fetched build. The
 * vault's verifiers are deployed from their artifacts, so they are pinned too.
 */
const SHAPES = [1, 2, 3, 4, 5].flatMap((n) => [1, 2, 3, 4, 5].map((m) => `VerifierArtifacts.sol:Transact${n}x${m}Verifier`))
export const POOL_CONTRACTS = [
	"AccessRouter.sol:AccessRouter",
	"Keystore.sol:Keystore",
	"ASPRegistry.sol:ASPRegistry",
	"PoolVault.sol:PoolVault",
	"Entrypoint.sol:Entrypoint",
	"PrivacyPoolRelay.sol:PrivacyPoolRelay",
	"ERC1967Proxy.sol:ERC1967Proxy",
	"LeanIMT.sol:LeanIMT",
	"VerifierArtifacts.sol:DepositVerifier",
	"VerifierArtifacts.sol:RagequitVerifier",
	...SHAPES,
] as const
const POOL_OUT = "../../pp-env/.ppv2/packages/contracts/out/"
const FIXTURE_OUT = "../../pp-env/contracts/out/"
/** pp-env's own test token, which `deploy-pool` deploys beside the pool. */
const FIXTURES = ["TestToken.sol:TestToken"] as const

/** A deploy-time library link hashes as zeros: its address is whatever forge deployed, checked after the deploy. */
const UNLINKED = /__\$[0-9a-f]{34}\$__/g

function creationOf(out: string, id: string): Hex {
	const [file, name] = id.split(":") as [string, string]
	const code = readJson<{ bytecode: { object: string } }>(`${out}${file}/${name}.json`).bytecode.object
	// The fetched build is the same bytes everywhere, metadata included (some of its artifacts carry none).
	return keccak256(code.replace(UNLINKED, "0".repeat(40)) as Hex)
}

/** The own pool's creation-code hashes in the fetched build. */
export function poolCreationCodes(): Record<string, Hex> {
	const out: Record<string, Hex> = {}
	for (const id of POOL_CONTRACTS) out[id] = creationOf(POOL_OUT, id)
	for (const id of FIXTURES) out[id] = creationOf(FIXTURE_OUT, id)
	return out
}

export async function classIds(): Promise<Record<"labelledToken" | "tokenBridgeHub" | "aspRootRegistry", string>> {
	const id = async (a: Parameters<typeof getContractClassFromArtifact>[0]) => (await getContractClassFromArtifact(a)).id.toString()
	return {
		labelledToken: await id(labelledTokenArtifact),
		tokenBridgeHub: await id(tokenBridgeHubArtifact),
		aspRootRegistry: await id(aspRootRegistryArtifact),
	}
}

export const committedPoolCodes = () => readJson<Record<string, Hex>>("../pool-creation-codes.json")
export const committedClassIds = () => readJson<Record<string, string>>("../class-ids.json")

/** Each key of `want` whose value `got` does not repeat, as `key: got, committed want`. */
export function pinMismatches(got: Record<string, string>, want: Record<string, string>): string[] {
	const keys = new Set([...Object.keys(got), ...Object.keys(want)])
	return [...keys].filter((k) => got[k] !== want[k]).map((k) => `${k}: ${got[k] ?? "absent"}, committed ${want[k] ?? "absent"}`)
}
