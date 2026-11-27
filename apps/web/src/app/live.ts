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
	/** A bridge sends from the local demo's dev account, not the wallet's selected one; cleared on sign-out and on a wallet switch. */
	demo: boolean
}

export interface LiveStore {
	get(): Live
	set(patch: Partial<Live>): void
	subscribe(f: () => void): () => void
	/** The driver's view: the store plus the build's deployment, with the account a bridge sends from. */
	context(): LiveContext
}

/** `demoSender`: the local demo's dev account, which `demo` puts in the wallet's place as the sender. */
export function createLiveStore(deployment: string, demoSender: Address | null = null): LiveStore {
	let live: Live = { owner: null, account: null, chainId: null, epoch: null, aztecAccounts: [], demo: false }
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
		context: () => {
			const { account, ...rest } = live
			return { ...rest, account: live.demo && demoSender ? demoSender : account, selected: account, deployment }
		},
	}
}

export const useLive = (store: LiveStore): Live => useSyncExternalStore(store.subscribe, store.get)
