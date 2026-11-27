import { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { TxExecutionResult } from "@aztec-labs/aztec.js/tx"
import { labelledTokenArtifact } from "@pp/labelled-token"
import { describe, expect, it, vi } from "vitest"
import { liveBirthSource } from "./live"

type Filter = { contractAddress: AztecAddress; txHash: { toString(): string }; afterEvent?: unknown }
const node = vi.hoisted(() => ({ pages: [] as { events: unknown[]; nextCursor?: unknown }[], filters: [] as Filter[] }))
vi.mock("@aztec-labs/aztec.js/events", async (importOriginal) => ({
	...(await importOriginal<typeof import("@aztec-labs/aztec.js/events")>()),
	getPublicEvents: async (_node: unknown, _meta: unknown, filter: Filter) => {
		node.filters.push(filter)
		return node.pages.shift()
	},
}))

const token = AztecAddress.fromBigIntUnsafe(0x7001n)
const owner = AztecAddress.fromBigIntUnsafe(0x0a11cen)
const txHash = `0x${"0a".repeat(32)}`

describe("liveBirthSource", () => {
	it("reads every page of the token's debits in the announcement's own transaction", async () => {
		const debit = (i: number) => ({ event: { birth_id: BigInt(i), owner, amount: 1n } })
		const cursor = { page: 1 }
		node.pages.push({ events: Array.from({ length: 20 }, (_, i) => debit(i)), nextCursor: cursor }, { events: [debit(20)] })
		const receipt = { executionResult: TxExecutionResult.SUCCESS, blockNumber: 7, txEffect: { nullifiers: [] } }
		const src = await liveBirthSource({
			wallet: {} as never,
			node: { getTxReceipt: async () => receipt } as never,
			intake: owner,
			artifact: labelledTokenArtifact,
			syncedBlock: async () => 7,
			blockHash: async () => "0x07",
		})
		const tx = await src.tx(token, txHash)
		expect(tx.debits.map((d) => d.birthId)).toEqual(Array.from({ length: 21 }, (_, i) => BigInt(i)))
		expect(node.filters.map((f) => [f.contractAddress.equals(token), f.txHash.toString(), f.afterEvent])).toEqual([
			[true, txHash, undefined],
			[true, txHash, cursor],
		])
	})
})
