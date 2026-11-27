import type { Tx, TxHash, TxReceipt } from "@aztec-labs/stdlib/tx"
import { describe, expect, it } from "vitest"
import { type ProvingResult, proveOnly, type SendNode, sendAndWait } from "./account"

const HASH = { toString: () => `0x${"ab".repeat(32)}` } as unknown as TxHash
const TX = { getTxHash: () => HASH } as unknown as Tx

const result: ProvingResult = {
	toTx: async () => TX,
	publicInputs: {
		constants: {
			anchorBlockHeader: {
				getBlockNumber: () => 41,
				hash: async () => ({ toString: () => `0x${"cd".repeat(32)}` }),
				globalVariables: { timestamp: 1_700_000_000n },
			},
		},
	},
}

/** A wallet whose send proves through its PXE, then broadcasts through its node, as `BaseWallet.sendTx` does. */
function fakeWallet() {
	const broadcast: Tx[] = []
	class Pxe {
		async proveTx(): Promise<ProvingResult> {
			return result
		}
	}
	const pxe = new Pxe()
	const send = async () => {
		const proven = await pxe.proveTx()
		broadcast.push(await proven.toTx())
	}
	return { wallet: { pxe }, pxe, send, broadcast }
}

describe("proveOnly", () => {
	it("returns the proven transaction, its hash and its anchor, broadcasts nothing, and restores the PXE", async () => {
		const w = fakeWallet()
		const proven = await proveOnly(w.wallet, w.send)
		expect(proven).toEqual({ tx: TX, txHash: HASH, anchor: { number: 41, hash: `0x${"cd".repeat(32)}`, timestamp: 1_700_000_000n } })
		expect(w.broadcast).toEqual([])
		expect(Object.hasOwn(w.pxe, "proveTx")).toBe(false)
		await w.send()
		expect(w.broadcast).toEqual([TX])
	})

	it("passes a failure before the proof through", async () => {
		const w = fakeWallet()
		await expect(proveOnly(w.wallet, () => Promise.reject(new Error("simulation reverted")))).rejects.toThrow("simulation reverted")
		expect(Object.hasOwn(w.pxe, "proveTx")).toBe(false)
	})
})

const receipt = (status: string, executionResult?: string) => ({ status, executionResult }) as unknown as TxReceipt

/** A node that accepts the send (or throws `sendError`) and answers each receipt read with the next of `receipts`, repeating the last. */
function fakeNode(receipts: (TxReceipt | Error)[], sendError?: Error): SendNode & { sent: number } {
	let i = 0
	const node = {
		sent: 0,
		sendTx: async () => {
			node.sent++
			if (sendError) throw sendError
		},
		getTxReceipt: async () => {
			const r = receipts[Math.min(i++, receipts.length - 1)] as TxReceipt | Error
			if (r instanceof Error) throw r
			return r
		},
	}
	return node as unknown as SendNode & { sent: number }
}

const wait = (node: SendNode) => sendAndWait(node, { tx: TX, txHash: HASH }, { l2WaitTimeoutSec: 0.05, pollMs: 5 })

describe("sendAndWait", () => {
	it("ends at a checkpointed receipt, telling success from revert, after a transient DROPPED", async () => {
		const ok = await wait(fakeNode([receipt("dropped"), receipt("proposed"), receipt("checkpointed", "success")]))
		expect([ok.status, ok.proposedMs !== undefined && ok.proposedMs <= ok.ms]).toEqual(["checkpointed", true])
		const reverted = await wait(fakeNode([receipt("pending"), receipt("proven", "reverted")]))
		expect(reverted.status).toBe("reverted")
	})

	it("leaves every open fate unresolved and sends exactly once", async () => {
		const outcomes = [
			[fakeNode([receipt("pending")], new Error("connection reset")), "send"],
			[fakeNode([receipt("pending"), new Error("503")]), "read"],
			[fakeNode([receipt("dropped")]), "dropped"],
			[fakeNode([receipt("proposed")]), "timeout"],
		] as const
		for (const [node, reason] of outcomes) {
			expect(await wait(node)).toMatchObject({ status: "unresolved", txHash: HASH, reason })
			expect(node.sent).toBe(1)
		}
	})
})
