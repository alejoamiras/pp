import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { encodeAbiParameters, encodeEventTopics, type Hex, type Log } from "viem"
import { describe, expect, it, vi } from "vitest"
import { TOKEN_PORTAL_ABI } from "../../src/factory-abi"
import type { L1Ctx } from "../../src/flows"
import { depositViaPortal, readPortalDeposit } from "./deposit"

const PORTAL = "0x00000000000000000000000000000000000000a1"
const TOKEN = "0x00000000000000000000000000000000000e2c20"
const TO = `0x${"22".repeat(32)}` as Hex
const SECRET_HASH = `0x${"33".repeat(32)}` as Hex
const KEY = `0x${"44".repeat(32)}` as Hex

function publicDepositLog(address: string, f: { amount: bigint; secretHash?: Hex; index?: bigint }): Log {
	return {
		address,
		topics: encodeEventTopics({ abi: TOKEN_PORTAL_ABI, eventName: "DepositToAztecPublic" }),
		data: encodeAbiParameters(
			[{ type: "bytes32" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }],
			[TO, f.amount, f.secretHash ?? SECRET_HASH, KEY, f.index ?? 7n],
		),
	} as unknown as Log
}

describe("readPortalDeposit", () => {
	const expected = { amount: 100n, secretHash: SECRET_HASH, to: TO }

	it("takes the leaf from the portal's event and ignores a token's look-alike", () => {
		const spoof = publicDepositLog(TOKEN, { amount: 100n, index: 999n })
		expect(readPortalDeposit([spoof, publicDepositLog(PORTAL, { amount: 100n })], PORTAL, expected)).toEqual({ key: KEY, index: 7n })
		expect(() => readPortalDeposit([spoof], PORTAL, expected)).toThrow(/found 0/)
	})

	it("refuses a duplicated event, a mismatched field and the wrong event kind", () => {
		const real = publicDepositLog(PORTAL, { amount: 100n })
		expect(() => readPortalDeposit([real, real], PORTAL, expected)).toThrow(/found 2/)
		expect(() => readPortalDeposit([publicDepositLog(PORTAL, { amount: 99n })], PORTAL, expected)).toThrow(/amount 99/)
		expect(() => readPortalDeposit([publicDepositLog(PORTAL, { amount: 100n, secretHash: KEY })], PORTAL, expected)).toThrow(
			/another secret hash/,
		)
		expect(() => readPortalDeposit([real], PORTAL, { amount: 100n, secretHash: SECRET_HASH })).toThrow(/expected DepositToAztecPrivate/)
	})
})

describe("depositViaPortal", () => {
	async function offCurve(): Promise<string> {
		for (let x = 1n; ; x++) {
			const a = AztecAddress.fromStringUnsafe(`0x${x.toString(16).padStart(64, "0")}`)
			if (!(await a.isValid())) return a.toString()
		}
	}

	it("refuses a non-positive amount and an invalid recipient before any read or write", async () => {
		const l1 = { pub: { readContract: vi.fn() }, wallet: { writeContract: vi.fn() } } as unknown as L1Ctx
		const base = { factory: PORTAL, hub: TO, tokenClassId: SECRET_HASH, erc20: TOKEN, isPrivate: false } as const
		await expect(depositViaPortal(l1, { ...base, amount: 0n, recipient: TO })).rejects.toThrow(/must be positive/)
		await expect(depositViaPortal(l1, { ...base, amount: 1n, recipient: `0x${"0".repeat(64)}` })).rejects.toThrow(/not a valid Aztec/)
		await expect(depositViaPortal(l1, { ...base, amount: 1n, recipient: await offCurve(), isPrivate: true })).rejects.toThrow(
			/not a valid Aztec/,
		)
		expect(l1.pub.readContract).not.toHaveBeenCalled()
		expect(l1.wallet.writeContract).not.toHaveBeenCalled()
	})
})
