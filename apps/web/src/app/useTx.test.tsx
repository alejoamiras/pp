// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, renderHook } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, expect, test } from "vitest"
import { createFixtureSource } from "../data/fixtures"
import { ACCOUNTS } from "../data/fixtures/seed"
import type { Sent } from "../data/ports"
import { useTx } from "./useTx"

afterEach(cleanup)

const FROM = ACCOUNTS.aztec

function tx() {
	const { source } = createFixtureSource(null)
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
	return renderHook(() => useTx(source, () => {}), { wrapper }).result
}

test.each([
	{ when: "before the handoff", handed: false, code: "NOT_SENT", held: null },
	{ when: "past the handoff", handed: true, code: "UNKNOWN", held: "TX_UNSETTLED_NO_HASH" },
])("an uncoded throw $when reads $code and holds the account: $held", async ({ handed, code, held }) => {
	const result = tx()
	const failing = (handedOff: () => void): Promise<Sent> => {
		if (handed) handedOff()
		return Promise.reject(new Error("the node's socket closed"))
	}
	let outcome: unknown
	await act(async () => {
		outcome = await result.current.run("unshield", FROM, failing)
	})
	expect(outcome).toEqual({ ok: false, code })
	expect(result.current.blocked("unshield", FROM)).toBe(held)
})
