/**
 * The wallet context as it stands, written synchronously by wallet events and read synchronously by
 * the bridge driver's checks: a React render would land too late for a check right before a send.
 */
import { useSyncExternalStore } from "react"
import type { Address } from "viem"
import type { AztecAddress } from "../data/stack-types"
import type { LiveContext } from "../data/bridge-driver"

export interface Live {
	owner: Address | null
	account: Address | null
	chainId: number | null
	epoch: number | null
	aztecAccounts: readonly AztecAddress[]
}

export interface LiveStore {
	get(): Live
	set(patch: Partial<Live>): void
	subscribe(f: () => void): () => void
	/** The driver's view: the store plus the build's deployment. */
	context(): LiveContext
}

export function createLiveStore(deployment: string): LiveStore {
	let live: Live = { owner: null, account: null, chainId: null, epoch: null, aztecAccounts: [] }
	const listeners = new Set<() => void>()
	return {
		get: () => live,
		set(patch) {
			live = { ...live, ...patch }
			for (const f of [...listeners]) f()
		},
		subscribe(f) {
			listeners.add(f)
			return () => void listeners.delete(f)
		},
		context: () => ({ ...live, deployment }),
	}
}

export const useLive = (store: LiveStore): Live => useSyncExternalStore(store.subscribe, store.get)
