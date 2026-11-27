import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { FunctionType } from "@aztec-labs/stdlib/abi"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { describe, expect, it } from "vitest"
import { tokenBridgeHubArtifact } from "../artifacts"
import { callPayload } from "./payload"

const HUB = AztecAddress.fromBigIntUnsafe(1n)
const TOKEN = AztecAddress.fromBigIntUnsafe(7n)
const PAYEE = EthAddress.fromString("0x000000000000000000000000000000000000bEEF")

describe("callPayload", () => {
	it("builds a call to a public function, whose ABI sits outside the dispatch list", async () => {
		const [call] = (await callPayload(tokenBridgeHubArtifact, HUB, "exit_public", [TOKEN, PAYEE, 1n])).calls
		expect(call?.type).toBe(FunctionType.PUBLIC)
		expect(call?.args.map((a) => a.toBigInt())).toEqual([7n, 0xbeefn, 1n])
	})

	it("builds a call to a private function", async () => {
		const [call] = (await callPayload(tokenBridgeHubArtifact, HUB, "ragequit", [TOKEN, PAYEE, 1n, 5n])).calls
		expect(call?.type).toBe(FunctionType.PRIVATE)
		expect(call?.name).toBe("ragequit")
	})

	it("refuses a name the artifact does not have", async () => {
		await expect(callPayload(tokenBridgeHubArtifact, HUB, "exit_everything", [])).rejects.toThrow("Unknown function exit_everything")
	})
})
