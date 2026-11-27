import { describe, expect, test } from "vitest"
import type { AztecAddress } from "./stack-types"
import { stageManifest } from "./capabilities"

const at = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as AztecAddress
const T = { hub: at(0xa1), token: at(0xb2), sponsoredFpc: at(0xc3) }
const fn = (contract: AztecAddress, f: string) => ({ contract, function: f })
const sponsor = fn(T.sponsoredFpc, "sponsor_unconditionally")
const views = [fn(T.token, "private_balances_by_label"), fn(T.token, "private_notes_by_label")]

const manifest = (simulated: object[], sent: object[]) => ({
	version: "1.0",
	metadata: { name: "pp", version: "0.1.0" },
	capabilities: [
		{ type: "accounts", canGet: true, canCreateAuthWit: false },
		{ type: "contracts", contracts: [T.hub, T.token], canRegister: true, canGetMetadata: true },
		{ type: "simulation", transactions: { scope: [...simulated, sponsor] }, utilities: { scope: views } },
		{ type: "transaction", scope: [...sent, sponsor] },
	],
})

const A = [fn(T.hub, "claim_from_pool"), fn(T.hub, "ragequit")]
const B = [fn(T.token, "transfer_private"), fn(T.token, "unshield")]
const C = [fn(T.token, "shield")]
const D = [fn(T.hub, "exit_public")]
const PUBLIC = fn(T.token, "balance_of_public")

describe("the stage manifests", () => {
	test.each([
		["2a", manifest(A, A)],
		["2b", manifest([...A, PUBLIC, ...B], [...A, ...B])],
		["2c", manifest([...A, PUBLIC, ...B, ...C], [...A, ...B, ...C])],
		["2d", manifest([...A, PUBLIC, ...B, ...C, ...D], [...A, ...B, ...C, ...D])],
	] as const)("stage %s equals its literal and names no wildcard", (stage, literal) => {
		const m = stageManifest(stage, T)
		expect(m).toEqual(literal)
		expect(JSON.stringify(m)).not.toContain("*")
	})
})
