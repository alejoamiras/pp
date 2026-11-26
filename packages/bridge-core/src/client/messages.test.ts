import { computeFeeJuiceMessageNullifier } from "@aztec-labs/stdlib/messaging"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { bridgeContentV1, sha256ToField } from "@pp/bridge-spec"
import { deriveTokenClaimSecret } from "@pp/bridge-spec/claim-secret"
import { encodeAbiParameters, hexToBytes, pad, toHex } from "viem"
import { describe, expect, it } from "vitest"
import { bridgeMessageKey, claimNullifier } from "./messages"

const M = {
	portal: "0x00000000000000000000000000000000000000a1" as const,
	chainId: 31337,
	hub: toHex(0x0b5n, { size: 32 }),
	rollupVersion: 1234n,
}
const E = { nullifier: 11n, changeCommitment: 22n, amount: 70n, leafIndex: 5n }

describe("bridgeMessageKey", () => {
	it("equals the Inbox's sha256ToField(abi.encode(sender, chainId, recipient, version, content, secretHash, index))", async () => {
		const content = bridgeContentV1(E)
		const words = [BigInt(M.portal), 31337n, BigInt(M.hub), M.rollupVersion, content, 99n, E.leafIndex]
		const encoded = encodeAbiParameters(
			words.map(() => ({ type: "uint256" })),
			words,
		)
		const expected = pad(toHex(sha256ToField(hexToBytes(encoded))), { size: 32 })
		expect(await bridgeMessageKey(M, E, 99n)).toBe(expected)
		expect(await bridgeMessageKey(M, E, 98n)).not.toBe(expected)
	})
})

describe("claimNullifier", () => {
	it("is the protocol's one-field message nullifier under the derived claim secret", async () => {
		const key = await bridgeMessageKey(M, E, 99n)
		const recipient = toHex(0xabcn, { size: 32 })
		const got = await claimNullifier(M.hub, key, 7n, recipient)
		const secret = deriveTokenClaimSecret(new Fr(7n), AztecAddress.fromStringUnsafe(recipient))
		expect(got.nullifier.equals(await computeFeeJuiceMessageNullifier(Fr.fromString(key), secret))).toBe(true)
		expect(got.contractAddress.toString()).toBe(M.hub)
	})
})
