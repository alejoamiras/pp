import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadContractArtifact } from "@aztec-labs/stdlib/abi"
import { getContractClassFromArtifact } from "@aztec-labs/stdlib/contract"
import { describe, expect, it } from "vitest"

/**
 * Supply-chain tripwire: each committed bridge artifact must derive its pinned class id (bytecode + ABI, the
 * on-chain identity) and self-report the pinned toolchain. Re-pin only after `contracts/bridge/aztec/scripts/compile.sh`
 * rebuilds it on that toolchain; CI's `compile.sh --check` proves source parity.
 */

const here = dirname(fileURLToPath(import.meta.url))
const CONTRACTS = join(here, "..", "..", "..", "contracts", "bridge", "aztec")

const PINS = [
	{
		// The any-ERC-20 hub. Source parity with this artifact is checked by
		// `contracts/bridge/aztec/scripts/compile.sh --check` (a rebuild must derive this id).
		name: "TokenBridgeHub",
		path: join(CONTRACTS, "token_bridge_hub", "target", "token_bridge_hub_contract-TokenBridgeHub.json"),
		classId: "0x0d60dbd9919c0ab72b025c91db3405cf93150483a617df7383fb005cb7be0dd6",
	},
	{
		// The token class every hub derives; the hub's keystone vectors and the manifest pin it too.
		name: "LabelledToken",
		path: join(CONTRACTS, "labelled_token", "target", "labelled_token-LabelledToken.json"),
		classId: "0x1433444ed316fe06e46c3dfb026089b3488dc8b76162d768384a906f6a0c0bbc",
	},
	{
		name: "AspRootRegistry",
		path: join(CONTRACTS, "asp_registry", "target", "asp_registry-AspRootRegistry.json"),
		classId: "0x1222726dae8b2c3a611ef0ed963afcb49df70cdb296db224954f704bf11716a0",
	},
	{
		// Test-only consumer of the registry's library; committed for the network suite, never exported.
		name: "AspRegistryProbe",
		path: join(CONTRACTS, "asp_registry_probe", "target", "asp_registry_probe-AspRegistryProbe.json"),
		classId: "0x03f65333df9eea7277c78ac1ee1b8ec81e497220cf73aafd035184a3c17d123c",
	},
] as const

describe("committed bridge Noir artifacts — class-id tripwire (6.0.0)", () => {
	for (const pin of PINS) {
		it(`${pin.name} derives its pinned class id`, async () => {
			const artifact = loadContractArtifact(JSON.parse(readFileSync(pin.path, "utf8")))
			const cls = await getContractClassFromArtifact(artifact)
			expect(cls.id.toString()).toBe(pin.classId)
		})
	}

	it("every artifact self-reports aztec_version 6.0.0", () => {
		for (const pin of PINS) {
			const raw = JSON.parse(readFileSync(pin.path, "utf8")) as { aztecVersion?: string; aztec_version?: string }
			expect(raw.aztecVersion ?? raw.aztec_version).toBe("6.0.0")
		}
	})
})
