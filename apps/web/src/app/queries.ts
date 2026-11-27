/**
 * Reads, through TanStack Query; every transaction invalidates them all. Keys name what they read and
 * for whom, so a sign-out can drop the pool side alone.
 */
import { useQuery } from "@tanstack/react-query"
import { useCallback, useRef, useSyncExternalStore } from "react"
import type { Address } from "viem"
import type { AztecAddress, Origin } from "../data/stack-types"
import type { AllowListProgress, AllowListView, AztecPort, ExitView, Session } from "../data/ports"
import { readPool } from "../data/reconcile"
import type { DataSource } from "../data/source"

export const POOL_KEY = "pool"
/** The owner's keystore step, and its runs as mutations; a sign-out drops the step, never a run's outcome. */
export const REGISTRATION_KEY = "registration"

/**
 * `recipients`: the connected Aztec accounts, whose bridges `recover` finds even with no journal here;
 * `submitting`: the notes this page is sending, read at each fetch.
 */
export function usePool(session: Session | null, recipients: readonly AztecAddress[], submitting: () => ReadonlySet<bigint>) {
	return useQuery({
		queryKey: [POOL_KEY, session?.owner ?? null, ...recipients],
		queryFn: () => readPool(session as Session, recipients, submitting),
		enabled: session !== null,
	})
}

export function useBalances(aztec: AztecPort, account: AztecAddress | null, enabled: boolean) {
	return useQuery({
		queryKey: ["aztec", account, "balances"],
		queryFn: () => aztec.balancesByLabel(account as AztecAddress),
		enabled: enabled && account !== null,
	})
}

export function usePublicBalance(aztec: AztecPort, account: AztecAddress | null, enabled: boolean) {
	return useQuery({
		queryKey: ["aztec", account, "public"],
		queryFn: () => aztec.publicBalance(account as AztecAddress),
		enabled: enabled && account !== null,
	})
}

export function useLabelNotes(aztec: AztecPort, account: AztecAddress, label: bigint) {
	return useQuery({ queryKey: ["aztec", account, "notes", label.toString()], queryFn: () => aztec.notesByLabel(account, label) })
}

export const ALLOW_LIST_KEY = "allow-list"

/** The record and its time, read at one block. */
export function useAllowList(source: DataSource, enabled: boolean) {
	return useQuery({ queryKey: [ALLOW_LIST_KEY], queryFn: () => source.allowList.current(), enabled })
}

/**
 * One label's state under `view`, keyed by what the state depends on: the roots and both times, never
 * the sequence. Never retried: the adapter decides what a failed list costs.
 */
export function useLabelCheck(source: DataSource, view: AllowListView | undefined, label: bigint, origin: Origin) {
	const r = view?.record
	return useQuery({
		queryKey: [
			ALLOW_LIST_KEY,
			"check",
			r?.poolRoot.toString(),
			r?.birthRoot.toString(),
			r?.rootTime.toString(),
			view?.nowSec.toString(),
			label.toString(),
			origin,
		],
		queryFn: () => source.allowList.check(view as AllowListView, label, origin),
		enabled: view !== undefined,
		retry: false,
	})
}

/** A failed refetch keeps the last proven block read, which can only be lower than the node's. */
export function useAztecProven(source: DataSource, enabled: boolean) {
	return useQuery({ queryKey: ["clock", "aztec", "proven"], queryFn: () => source.clock.aztecProven(), enabled })
}

/** The running allow-list check's tree build, `null` while none hashes. */
export function useAllowListProgress(source: DataSource): AllowListProgress | null {
	const last = useRef<AllowListProgress | null>(null)
	const subscribe = useCallback(
		(notify: () => void) =>
			source.allowList.onProgress((p) => {
				last.current = p
				notify()
			}),
		[source],
	)
	return useSyncExternalStore(subscribe, () => last.current)
}

/** `deployment:l2TxHash:messageIndexInTx`: identical exits differ only by their message index. */
export const exitKey = (v: ExitView): string => `${v.key.deployment}:${v.key.l2TxHash}:${v.key.messageIndexInTx}`

export function useExits(source: DataSource, payees: readonly Address[]) {
	return useQuery({
		queryKey: ["exits", ...payees],
		queryFn: async () => {
			const lists = await Promise.all(payees.map((p) => source.exits.tickets(p)))
			const rows = new Map<string, ExitView>()
			for (const v of lists.flat()) rows.set(exitKey(v), v)
			return [...rows.values()]
		},
		enabled: payees.length > 0,
	})
}
