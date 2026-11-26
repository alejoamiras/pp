import { encodeAbiParameters, type Hex } from "viem"
import { describe, expect, it } from "vitest"
import {
	bridgeContentPreimageV1,
	bridgeContentV1,
	bridgeDataV1,
	exitContentPreimageV1,
	exitContentV1,
	ragequitContentPreimageV1,
	ragequitContentV1,
} from "./encode"
import { BN254_P, SpecRangeError, toHex, U128_MAX } from "./fields"
import { TAG_STRINGS, TAGS, tagWord } from "./tags"

const P = BN254_P

/** Independent oracle: WebCrypto sha256, first 31 bytes. */
async function webSha256ToField(hex: Hex): Promise<bigint> {
	const bytes = Uint8Array.from(Buffer.from(hex.slice(2), "hex"))
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
	return BigInt(`0x${Buffer.from(digest.subarray(0, 31)).toString("hex")}`)
}

const code = (f: () => unknown) => {
	try {
		f()
	} catch (e) {
		if (e instanceof SpecRangeError) return e.code
		throw e
	}
	return "no error"
}

describe("tags", () => {
	it("each tag is its ASCII string read big-endian, below 2^248", () => {
		for (const k of Object.keys(TAGS) as (keyof typeof TAGS)[]) {
			expect(BigInt(TAGS[k])).toBe(tagWord(TAG_STRINGS[k]))
			expect(BigInt(TAGS[k]) < 1n << 248n).toBe(true)
		}
	})
})

describe("encoders match viem abi.encode and WebCrypto sha256", () => {
	// Distinct non-zero words, so a swapped or dropped word cannot pass.
	const nullifier = 0x1111n
	const changeCommitment = P - 2n
	const amount = 0x3333n
	const payee = "0x00000000000000000000000000000000000044a4" as const
	const label = 0x5555n

	it("bridgeDataV1 = abi.encode(PP_BRIDGE_DATA_V1, secretHash)", () => {
		const secretHash = `0x${(P - 1n).toString(16).padStart(64, "0")}` as Hex
		expect(bridgeDataV1(secretHash)).toBe(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], [TAGS.DATA_V1, secretHash]))
	})

	it("inbox content", async () => {
		const pre = encodeAbiParameters(
			[{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
			[TAGS.IN_V1, nullifier, changeCommitment, amount],
		)
		expect(toHex(bridgeContentPreimageV1({ nullifier, changeCommitment, amount }))).toBe(pre)
		expect(bridgeContentV1({ nullifier, changeCommitment, amount })).toBe(await webSha256ToField(pre))
	})

	it("screened-exit content", async () => {
		const pre = encodeAbiParameters([{ type: "bytes32" }, { type: "address" }, { type: "uint256" }], [TAGS.OUT_V1, payee, amount])
		expect(toHex(exitContentPreimageV1({ payee, amount }))).toBe(pre)
		expect(exitContentV1({ payee, amount })).toBe(await webSha256ToField(pre))
	})

	it("ragequit content", async () => {
		const pre = encodeAbiParameters(
			[{ type: "bytes32" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }],
			[TAGS.RAGEQUIT_V1, payee, amount, label],
		)
		expect(toHex(ragequitContentPreimageV1({ payee, amount, label }))).toBe(pre)
		expect(ragequitContentV1({ payee, amount, label })).toBe(await webSha256ToField(pre))
	})
})

describe("rejections by name", () => {
	const ok = { nullifier: 1n, changeCommitment: 1n, amount: 1n }
	const payee = "0x0000000000000000000000000000000000000001" as const
	const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}` as Hex

	it.each([
		["amount 0", () => bridgeContentV1({ ...ok, amount: 0n }), "AmountOutOfRange"],
		["amount 2^128", () => bridgeContentV1({ ...ok, amount: U128_MAX + 1n }), "AmountOutOfRange"],
		["negative amount", () => exitContentV1({ payee, amount: -1n }), "AmountOutOfRange"],
		["nullifier p", () => bridgeContentV1({ ...ok, nullifier: P }), "FieldOutOfRange"],
		["change commitment p", () => bridgeContentV1({ ...ok, changeCommitment: P }), "FieldOutOfRange"],
		["secretHash 0", () => bridgeDataV1(word(0n)), "SecretHashOutOfRange"],
		["secretHash p", () => bridgeDataV1(word(P)), "SecretHashOutOfRange"],
		["secretHash of 31 bytes", () => bridgeDataV1(`0x${"11".repeat(31)}`), "SecretHashOutOfRange"],
		["payee 0", () => exitContentV1({ payee: `0x${"00".repeat(20)}`, amount: 1n }), "ZeroPayee"],
		["payee word 2^160", () => exitContentV1({ payee: `0x01${"00".repeat(20)}`, amount: 1n }), "PayeeOutOfRange"],
		["label 0", () => ragequitContentV1({ payee, amount: 1n, label: 0n }), "LabelOutOfRange"],
		["label p", () => ragequitContentV1({ payee, amount: 1n, label: P }), "LabelOutOfRange"],
	])("%s", (_, f, want) => {
		expect(code(f)).toBe(want)
	})
})
