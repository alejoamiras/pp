// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import type { Hex } from "viem"
import { afterEach, expect, test, vi } from "vitest"
import { BridgeFailure } from "../data/errors"
import { createFixtureSource } from "../data/fixtures"
import { ACCOUNTS } from "../data/fixtures/seed"
import type { ReceiptPort, Sent } from "../data/ports"
import { useTx } from "./useTx"

afterEach(cleanup)

const FROM = ACCOUNTS.aztec
const TX_HASH: Hex = `0x${"ab".repeat(32)}`

function tx(receipts?: ReceiptPort) {
	const { source } = createFixtureSource(null)
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
	return renderHook(() => useTx(receipts ? { ...source, receipts } : source, () => {}), { wrapper }).result
}

test.each([
	{ when: "before the handoff", handed: false, error: new Error("the node's socket closed"), code: "NOT_SENT", held: null },
	{ when: "before the handoff", handed: false, error: new BridgeFailure("PAGE_LOAD_FAILED"), code: "NOT_SENT", held: null },
	{ when: "past the handoff", handed: true, error: new Error("the node's socket closed"), code: "UNKNOWN", held: "TX_UNSETTLED_NO_HASH" },
])("$error.message thrown $when reads $code and holds the account: $held", async ({ handed, error, code, held }) => {
	const result = tx()
	const failing = (handedOff: () => void): Promise<Sent> => {
		if (handed) handedOff()
		return Promise.reject(error)
	}
	let outcome: unknown
	await act(async () => {
		outcome = await result.current.run("unshield", FROM, failing)
	})
	expect(outcome).toEqual({ ok: false, code })
	expect(result.current.blocked("unshield", FROM)).toBe(held)
})

test("check returns nothing for a receipt read whose chunk failed to load: the send stays held, and a later check reads it again", async () => {
	const aztec = vi
		.fn<ReceiptPort["aztec"]>()
		.mockRejectedValueOnce(new BridgeFailure("PAGE_LOAD_FAILED"))
		.mockResolvedValueOnce({ status: "success" })
	const result = tx({ aztec })
	await act(async () => {
		await result.current.run("unshield", FROM, async (handedOff) => {
			handedOff()
			return { status: "unconfirmed", txHash: TX_HASH }
		})
	})
	expect(result.current.blocked("unshield", FROM)).toBe("TX_UNSETTLED")
	await act(async () => {
		await result.current.check()
	})
	expect(result.current.blocked("unshield", FROM)).toBe("TX_UNSETTLED")
	await act(async () => {
		await result.current.check()
	})
	expect(aztec.mock.calls).toEqual([[TX_HASH], [TX_HASH]])
	expect(result.current.blocked("unshield", FROM)).toBe(null)
})
