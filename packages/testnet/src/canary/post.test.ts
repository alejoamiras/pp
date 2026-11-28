import type { Hex } from "viem"
import { describe, expect, it } from "vitest"
import { resolvePost } from "./run"

const POST = `0x${"0a".repeat(32)}` as Hex
const hashOf = (n: number) => ({ toString: () => `0x${n.toString(16).padStart(64, "0")}` })

/** A node whose receipt for `--post` names block 7 as `receiptBlock`, and which serves `servedBlock` at height 7. */
const node = (receiptBlock: number, servedBlock: number) =>
	({
		getTxReceipt: async () => ({ status: "checkpointed", executionResult: "success", blockNumber: 7, blockHash: hashOf(receiptBlock) }),
		getBlockData: async () => ({ blockHash: hashOf(servedBlock) }),
	}) as unknown as Parameters<typeof resolvePost>[0]["node"]

describe("resolvePost", () => {
	it("takes --post's own block, and refuses one the node no longer serves at that height", async () => {
		await expect(resolvePost({ node: node(1, 1), postHash: POST })).resolves.toEqual({ block: 7, blockHash: hashOf(1).toString() })
		await expect(resolvePost({ node: node(1, 2), postHash: POST })).rejects.toMatchObject({ errorClass: "POST_REORGED" })
	})
})
