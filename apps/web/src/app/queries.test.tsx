// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, expect, test, vi } from "vitest"
import { createFixtureSource } from "../data/fixtures"
import type { AllowListView } from "../data/ports"
import type { LabelCheck } from "../data/stack-types"
import { useLabelCheck } from "./queries"

afterEach(cleanup)

test.each(["poolSize", "birthSize"] as const)(
	"a record with the same roots and times but another %s is checked again, never shown the old list's state",
	async (length) => {
		const { source: base } = createFixtureSource(null)
		const first = await base.allowList.current()
		const check = vi.fn(
			async (view: AllowListView): Promise<LabelCheck> =>
				view.record[length] === first.record[length]
					? { state: "ACTIVE", path: { index: 0, depth: 0, siblings: [] } }
					: { state: "ABSENT" },
		)
		const source = { ...base, allowList: { ...base.allowList, check } }
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
		const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
		const longer: AllowListView = { ...first, record: { ...first.record, [length]: first.record[length] + 1n } }
		const { result, rerender } = renderHook(({ view }) => useLabelCheck(source, view, 5n, 0), {
			wrapper,
			initialProps: { view: first },
		})
		await waitFor(() => expect(result.current.data?.state).toBe("ACTIVE"))
		rerender({ view: longer })
		await waitFor(() => expect(result.current.data?.state).toBe("ABSENT"))
		expect(check).toHaveBeenCalledTimes(2)
	},
)

test("a registry never posted that is then reset at the same time is checked again, so its rows say which", async () => {
	const { source } = createFixtureSource(null)
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
	const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
	const none = { poolRoot: 0n, birthRoot: 0n, l1Block: 0n, rootTime: 0n, poolSize: 0n, birthSize: 0n }
	const at = (sequence: bigint): AllowListView => ({ record: { ...none, sequence }, nowSec: 1_000n })
	const { result, rerender } = renderHook(({ view }) => useLabelCheck(source, view, 5n, 0), {
		wrapper,
		initialProps: { view: at(0n) },
	})
	await waitFor(() => expect(result.current.error).toMatchObject({ code: "LIST_NOT_POSTED" }))
	rerender({ view: at(1n) })
	await waitFor(() => expect(result.current.error).toMatchObject({ code: "LIST_RESETTING" }))
})
