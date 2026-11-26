/**
 * Reads, through TanStack Query; every transaction invalidates them all. Keys name what they read and
 * for whom, so a sign-out can drop the pool side alone.
 */
import { useQuery } from "@tanstack/react-query"
import type { Address } from "viem"
import type { AztecAddress } from "../data/a7"
import type { AllowListView, AztecPort, ExitView, Session } from "../data/ports"
import { readPool } from "../data/reconcile"
import type { DataSource } from "../data/source"

export const POOL_KEY = "pool"

export function usePool(session: Session | null) {
	return useQuery({
		queryKey: [POOL_KEY, session?.owner ?? null],
		queryFn: () => readPool(session as Session),
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

export interface AllowListAt {
	view: AllowListView
	/** The Aztec chain time the states are read at. */
	nowSec: bigint
}

export function useAllowList(source: DataSource, enabled: boolean) {
	return useQuery({
		queryKey: ["allow-list"],
		queryFn: async (): Promise<AllowListAt> => {
			const [view, nowSec] = await Promise.all([source.allowList.current(), source.clock.aztecNow()])
			return { view, nowSec }
		},
		enabled,
	})
}

export function useAztecNow(source: DataSource) {
	return useQuery({ queryKey: ["clock", "aztec"], queryFn: () => source.clock.aztecNow() })
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
