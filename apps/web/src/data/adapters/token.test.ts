import { fromWord, PORTAL_FACTORY_ABI, toWord, utf8 } from "@pp/bridge-core"
import { type Address, createPublicClient, custom, decodeFunctionData, encodeAbiParameters, type Hex } from "viem"
import { expect, test } from "vitest"
import { REGISTRATION_OF, readToken, wordText } from "./token"

const FACTORY: Address = "0x00000000000000000000000000000000000000f1"
const ASSET: Address = "0x00000000000000000000000000000000000000A5"
const PORTAL: Address = "0x00000000000000000000000000000000000000d4"
const ZERO: Address = "0x0000000000000000000000000000000000000000"
const O = { factory: FACTORY, asset: ASSET, portal: PORTAL }

test("the registration entry and the word decoding are bridge-core's", () => {
	expect(REGISTRATION_OF).toEqual(PORTAL_FACTORY_ABI.find((e) => e.type === "function" && e.name === "registrationOf"))
	for (const raw of ["USDC", "Tab\there", "", "x".repeat(40)]) {
		const w = toWord(utf8(raw))
		expect(wordText(w)).toBe(fromWord(w))
	}
})

/** `registrationOf`'s return data as a node could send it, any word set by hand. */
function returnData(o: { portal?: Address; decimalsWord?: bigint; symbolWord?: Hex } = {}): Hex {
	const fields = REGISTRATION_OF.outputs[0].components
	const symbol = o.symbolWord ?? toWord(utf8("TST"))
	const data = encodeAbiParameters(fields, [o.portal ?? PORTAL, 6, 0n, toWord(utf8("Test")), symbol, `0x${"00".repeat(32)}`])
	const decimals = (o.decimalsWord ?? 6n).toString(16).padStart(64, "0")
	return `${data.slice(0, 66)}${decimals}${data.slice(130)}` as Hex
}

/** A node whose every `eth_call` must be the factory's `registrationOf(ASSET)`, answered with `data`. */
const node = (data: Hex) =>
	createPublicClient({
		transport: custom({
			async request({ method, params }) {
				if (method !== "eth_call") throw new Error(`${method} unexpected`)
				const [call] = params as [{ to: Address; data: Hex }]
				expect(call.to.toLowerCase()).toBe(FACTORY)
				expect(decodeFunctionData({ abi: [REGISTRATION_OF], data: call.data }).args).toEqual([ASSET])
				return data
			},
		}),
	})

test("reads the decimals and symbol the factory froze for the manifest's portal, and refuses another portal", async () => {
	await expect(readToken(node(returnData()), O)).resolves.toEqual({ decimals: 6, symbol: "TST" })
	for (const portal of [ZERO, ASSET])
		await expect(readToken(node(returnData({ portal })), O)).rejects.toMatchObject({ code: "DEPLOYMENT_MISMATCH" })
})

test("refuses decimals that do not fit a uint8 or exceed 36, and a symbol word that is not printable ASCII", async () => {
	const word = (bytes: number[]) =>
		`0x${[0, ...bytes]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("")
			.padEnd(64, "0")}` as Hex
	for (const d of [0n, 36n])
		await expect(readToken(node(returnData({ decimalsWord: d })), O)).resolves.toMatchObject({ decimals: Number(d) })
	const refused: Hex[] = [
		returnData({ decimalsWord: 37n }),
		returnData({ decimalsWord: 300n }),
		returnData({ decimalsWord: 2n ** 200n }),
		returnData({ symbolWord: word([0x54, 0x07, 0x54]) }),
		returnData({ symbolWord: word([0x54, 0xe2, 0x80, 0xae]) }),
		returnData({ symbolWord: word([0x54, 0, 0x54]) }),
		returnData({ symbolWord: `0x54${"00".repeat(31)}` }),
		"0x",
	]
	for (const data of refused) await expect(readToken(node(data), O)).rejects.toMatchObject({ code: "DEPLOYMENT_MISMATCH" })
})
