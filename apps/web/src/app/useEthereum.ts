import { useCallback, useEffect, useRef, useState } from "react"
import { openOwnerSession } from "../data/chain"
import { codeOf, isUserRejection, type UiCode } from "../data/errors"
import type { Session } from "../data/ports"
import type { DataSource } from "../data/source"
import type { LiveStore } from "./live"

export type EthStatus = { kind: "out" } | { kind: "signing" } | { kind: "in"; session: Session } | { kind: "error"; code: UiCode }

const signInFailure = (err: unknown): EthStatus => ({
	kind: "error",
	code: isUserRejection(err) ? "WALLET_REJECTED" : (codeOf(err) ?? "RPC_FAILED"),
})

/**
 * The selected Ethereum account and chain, kept current from wallet events, and the owner's session.
 * The session stays bound to the owner while the user switches to a separate sender account.
 */
export function useEthereum(source: DataSource, live: LiveStore) {
	const [status, setStatus] = useState<EthStatus>({ kind: "out" })
	const session = useRef<Session | null>(null)
	/** Advanced by each sign-in and sign-out: a sign-in that settles under a newer value is dropped. */
	const run = useRef(0)

	useEffect(() => {
		// A first read can resolve after a wallet event; the event is newer and wins.
		let current = true
		const heard = { account: false, chain: false }
		source.l1
			.accounts()
			.then((a) => current && !heard.account && live.set({ account: a[0] ?? null }))
			.catch(() => {})
		source.l1
			.chainId()
			.then((chainId) => current && !heard.chain && live.set({ chainId }))
			.catch(() => {})
		const offAccounts = source.l1.onAccountsChanged((a) => {
			heard.account = true
			live.set({ account: a[0] ?? null })
		})
		const offChain = source.l1.onChainChanged((chainId) => {
			heard.chain = true
			live.set({ chainId })
		})
		return () => {
			current = false
			offAccounts()
			offChain()
		}
	}, [source, live])

	useEffect(() => () => session.current?.close(), [])

	const signOut = useCallback(() => {
		run.current++
		session.current?.close()
		session.current = null
		live.set({ owner: null })
		setStatus({ kind: "out" })
	}, [live])

	const signIn = useCallback(async () => {
		signOut()
		const mine = run.current
		setStatus({ kind: "signing" })
		try {
			const opened = await openOwnerSession({ l1: source.l1, sessions: source.sessions, chainId: source.deployment.chainId })
			if (mine !== run.current) return opened.ok ? opened.session.close() : undefined
			if (!opened.ok) return setStatus({ kind: "error", code: opened.code })
			session.current = opened.session
			live.set({ owner: opened.session.owner })
			setStatus({ kind: "in", session: opened.session })
		} catch (err) {
			if (mine === run.current) setStatus(signInFailure(err))
		}
	}, [source, live, signOut])

	return { status, signIn, signOut }
}

export type Ethereum = ReturnType<typeof useEthereum>
