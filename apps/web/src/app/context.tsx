import { useQueryClient } from "@tanstack/react-query"
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react"
import type { Address } from "viem"
import { dispatchRefusal, guardAztec } from "../data/actions"
import type { AztecAction } from "../data/capabilities"
import type { UiCode } from "../data/errors"
import type { DataSource } from "../data/source"
import type { AztecConnection } from "../data/wallet/types"
import { type Connect, useConnect } from "../features/connect/useConnect"
import { createLiveStore, type LiveStore } from "./live"
import { POOL_KEY, usePool } from "./queries"
import { type BridgeFlow, useBridgeFlow } from "./useBridgeFlow"
import { type Ethereum, useEthereum } from "./useEthereum"
import { type Tx, useTx } from "./useTx"

export type View = "home" | "bridge" | "exits"

export interface App {
	source: DataSource
	live: LiveStore
	eth: Ethereum
	connect: Connect
	connection: AztecConnection | null
	/** The guarded port: a call the grant does not cover rejects before the port sees it. */
	aztec: DataSource["aztec"]
	refusal(action: AztecAction): Extract<UiCode, "STAGE_UNSUPPORTED" | "NOT_GRANTED"> | null
	bridge: BridgeFlow
	tx: Tx
	view: View
	go(view: View): void
	/** Payees whose exits the Exits screen lists, beyond the owner and the selected account. */
	payees: readonly Address[]
	addPayee(payee: Address): void
	refresh(): void
	forget(): Promise<void>
}

const AppContext = createContext<App | null>(null)

export function useApp(): App {
	const app = useContext(AppContext)
	if (!app) throw new Error("useApp outside AppProvider")
	return app
}

/** The Aztec side: the connection, kept in the live store, and the port behind the grant. */
function useAztecSide(source: DataSource, live: LiveStore) {
	const onConnection = useCallback(
		(c: AztecConnection | null) => live.set({ epoch: c?.epoch ?? null, aztecAccounts: c?.accounts ?? [] }),
		[live],
	)
	const connect = useConnect(source, onConnection)
	const connection = connect.step.kind === "connected" ? connect.step.connection : null
	const grant = useRef(connection?.grant ?? null)
	grant.current = connection?.grant ?? null
	const { stage } = source.deployment
	const refusal = useCallback(
		(action: AztecAction) => dispatchRefusal(connection?.grant ?? null, action, stage, source.deployment),
		[connection, stage, source],
	)
	const aztec = useMemo(
		() => guardAztec(source.aztec, (a) => dispatchRefusal(grant.current, a, stage, source.deployment) === null),
		[source, stage],
	)
	return { connect, connection, refusal, aztec }
}

interface Props {
	source: DataSource
	frame(): Promise<void>
	children: ReactNode
}

export function AppProvider({ source, frame, children }: Props) {
	const queryClient = useQueryClient()
	const live = useMemo(() => createLiveStore(source.deployment.id), [source])
	const eth = useEthereum(source, live)
	const side = useAztecSide(source, live)
	const [view, go] = useState<View>("home")
	const [payees, setPayees] = useState<readonly Address[]>([])
	const refresh = useCallback(() => void queryClient.invalidateQueries(), [queryClient])
	const tx = useTx(source, refresh)
	const session = eth.status.kind === "in" ? eth.status.session : null
	const bridge = useBridgeFlow({ source, live, session, canClaim: () => side.refusal("claim") === null, frame, settled: refresh })
	const pool = usePool(session, side.connection?.accounts ?? [], bridge.submitting).data
	const { hold } = bridge

	useEffect(() => {
		hold(new Set(pool?.inFlight.keys()))
	}, [pool, hold])

	useEffect(() => {
		if (session === null) queryClient.removeQueries({ queryKey: [POOL_KEY] })
	}, [session, queryClient])

	const { connect } = side
	const forget = useCallback(async () => {
		bridge.close()
		eth.signOut()
		await connect.close()
		await source.sessions.forget()
		queryClient.clear()
		setPayees([])
		go("home")
	}, [bridge, eth, connect, source, queryClient])

	const addPayee = useCallback((p: Address) => setPayees((list) => (list.includes(p) ? list : [...list, p])), [])
	const app: App = { source, live, eth, ...side, bridge, tx, view, go, payees, addPayee, refresh, forget }
	return <AppContext.Provider value={app}>{children}</AppContext.Provider>
}
