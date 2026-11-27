import { fromWord, PORTAL_FACTORY_ABI, toWord, utf8 } from "@pp/bridge-core"
import type { Address } from "viem"
import { expect, test } from "vitest"
import { REGISTRATION_OF, readToken, wordText } from "./token"

const FACTORY: Address = "0x00000000000000000000000000000000000000f1"
const ASSET: Address = "0x00000000000000000000000000000000000000a5"
const PORTAL: Address = "0x00000000000000000000000000000000000000d4"
const ZERO: Address = "0x0000000000000000000000000000000000000000"

test("the registration entry and the word decoding are bridge-core's", () => {
	expect(REGISTRATION_OF).toEqual(PORTAL_FACTORY_ABI.find((e) => e.type === "function" && e.name === "registrationOf"))
	for (const raw of ["USDC", "Tab\there", "", "x".repeat(40)]) {
		const w = toWord(utf8(raw))
		expect(wordText(w)).toBe(fromWord(w))
	}
})

test("reads the decimals and symbol the factory froze for the manifest's portal, and refuses another portal", async () => {
	const reads = (portal: Address) => ({
		readContract: async (args: { address: Address; functionName: string; args: readonly unknown[] }) => {
			expect(args).toMatchObject({ address: FACTORY, functionName: "registrationOf", args: [ASSET] })
			return {
				portal,
				decimals: 6,
				registerIndex: 0n,
				nameWord: toWord(utf8("Test")),
				symbolWord: toWord(utf8("TST")),
				registerKey: ZERO,
			}
		},
	})
	const o = { factory: FACTORY, asset: ASSET, portal: PORTAL }
	await expect(readToken(reads(PORTAL) as never, o)).resolves.toEqual({ decimals: 6, symbol: "TST" })
	for (const other of [ZERO, ASSET])
		await expect(readToken(reads(other) as never, o)).rejects.toMatchObject({ code: "DEPLOYMENT_MISMATCH" })
})
