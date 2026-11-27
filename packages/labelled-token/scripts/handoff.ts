/**
 * The derivation vector the hub's `derive_token` must reproduce for this token: `deployer = hub`,
 * `salt = erc20`, initialized by `constructor(name, symbol, decimals, hub, registry)` with the
 * factory-attested words as 31-char strings. Inputs mirror the hub's own keystone vector.
 *
 *   handoff.ts           write bench/handoff.json
 *   handoff.ts --check   fail if bench/handoff.json differs from a fresh derivation
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { getContractInstanceFromInstantiationParams } from "@aztec-labs/aztec.js/contracts"
import { PublicKeys } from "@aztec-labs/aztec.js/keys"
import { hubTokenSalt, wordToNoirString } from "@pp/bridge-core"
import { labelledTokenArtifact } from "../src/index"

export interface HandoffCase {
	registry: string
	initializationHash: string
	address: string
}

export interface Handoff {
	classId: string
	hub: string
	erc20: string
	nameWord: string
	symbolWord: string
	decimals: number
	cases: HandoffCase[]
}

const INPUTS = {
	hub: "0x1234000000000000000000000000000000000000000000000000000000000abc",
	erc20: "0x00000000000000000000000000000000000e2c20",
	nameWord: "0x005465737420546f6b656e000000000000000000000000000000000000000000",
	symbolWord: "0x0054535400000000000000000000000000000000000000000000000000000000",
	decimals: 18,
}
// Stage A deploys with no registry; later stages pass one, and both must derive alike in Noir.
const REGISTRIES = ["0x0000000000000000000000000000000000000000000000000000000000000000", `0x${"0".repeat(60)}7e57`]

export const handoffPath = join(dirname(fileURLToPath(import.meta.url)), "../bench/handoff.json")

export async function deriveHandoff(): Promise<Handoff> {
	const hub = AztecAddress.fromStringUnsafe(INPUTS.hub)
	let classId = ""
	const cases: HandoffCase[] = []
	for (const registry of REGISTRIES) {
		const inst = await getContractInstanceFromInstantiationParams(labelledTokenArtifact, {
			constructorArgs: [
				wordToNoirString(INPUTS.nameWord),
				wordToNoirString(INPUTS.symbolWord),
				INPUTS.decimals,
				hub,
				AztecAddress.fromStringUnsafe(registry),
			],
			constructorArtifact: "constructor",
			salt: hubTokenSalt(INPUTS.erc20),
			deployer: hub,
			publicKeys: PublicKeys.default(),
		})
		classId = inst.currentContractClassId.toString()
		cases.push({ registry, initializationHash: inst.initializationHash.toString(), address: inst.address.toString() })
	}
	return { classId, ...INPUTS, cases }
}

const render = (h: Handoff): string => `${JSON.stringify(h, null, "\t")}\n`

if (import.meta.main) {
	const fresh = render(await deriveHandoff())
	if (process.argv.includes("--check")) {
		if (readFileSync(handoffPath, "utf8") !== fresh) {
			console.error("bench/handoff.json is stale: run `bun run --cwd packages/labelled-token handoff`")
			process.exit(1)
		}
	} else {
		writeFileSync(handoffPath, fresh)
	}
}
