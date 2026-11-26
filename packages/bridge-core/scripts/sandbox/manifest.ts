/** The manifest the sandbox ships to its consumers, and the artifacts directory a run writes. */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ManifestToken, ManifestV2 } from "../../src/manifest-v2"
import { walletChainIdOf } from "../../src/wallet-chain-id"
import type { GenerationRecord } from "../generation"
import { CHAIN_ID } from "./constants"

export function buildManifest(gen: GenerationRecord, tokens: ManifestToken[], rollupVersion: number): ManifestV2 {
	return {
		schema: 2,
		network: "sandbox",
		l1ChainId: CHAIN_ID,
		walletChainId: walletChainIdOf(CHAIN_ID, rollupVersion),
		bridge: { l1: gen.l1, l2: gen.l2, tokens },
		privateClaimMode: "salt-v2",
	}
}

export interface RunArtifacts {
	manifest: ManifestV2
	handle: unknown
}

export const ARTIFACT_FILES = { manifest: "manifest.json", handle: "handle.json" } as const

/** Everything a consumer needs is JSON on disk: a browser build reads the manifest at config time,
 *  a test process reconstructs its clients from the handle. */
export function writeArtifacts(dir: string, a: RunArtifacts): void {
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, ARTIFACT_FILES.manifest), `${JSON.stringify(a.manifest, null, "\t")}\n`)
	writeFileSync(join(dir, ARTIFACT_FILES.handle), `${JSON.stringify(a.handle, null, "\t")}\n`)
}
