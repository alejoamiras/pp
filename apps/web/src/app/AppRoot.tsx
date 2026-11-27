import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState } from "react"
import type { DataSource } from "../data/source"
import { nextFrame } from "../data/timer"
import { BridgeScreen } from "../features/bridge/BridgeScreen"
import { DetailsButton } from "../features/details/Details"
import { ExitsScreen } from "../features/exits/ExitsScreen"
import { Home } from "../features/balances/Home"
import { ActionButton, ConnectionPill, shortHex, Tabs } from "../ui"
import { AppProvider, useApp, type View } from "./context"
import { RECOVERY_PLAIN } from "./copy"
import { useLive } from "./live"

interface Props {
	source: DataSource
	/** Resolves after the next paint; tests pass one that resolves at once. */
	frame?(): Promise<void>
	/** Milliseconds between background re-reads, or `false` for none. */
	poll?: number | false
}

const SECTIONS: { key: View; label: string }[] = [
	{ key: "home", label: "Balances" },
	{ key: "exits", label: "Exits" },
]

function Header() {
	const { live, connection } = useApp()
	const { account } = useLive(live)
	const aztec = connection?.accounts[0]
	return (
		<header className="flex flex-wrap items-center justify-between gap-3">
			<div>
				<h1 className="text-2xl font-bold tracking-[-0.02em]">Label bridge</h1>
				<p className="text-ink-3">Move labelled funds between the pool on Ethereum and Aztec.</p>
			</div>
			<div className="flex flex-wrap items-center gap-1.5">
				{account ? <ConnectionPill name="Ethereum" value={shortHex(account)} title={account} /> : null}
				{aztec ? <ConnectionPill name="Aztec" value={shortHex(aztec)} title={aztec} /> : null}
				<DetailsButton />
			</div>
		</header>
	)
}

function Shell() {
	const { view, go, bridge } = useApp()
	const tab = view === "bridge" ? null : view
	return (
		<main className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 sm:py-8">
			<Header />
			<div className="flex flex-wrap items-center gap-3">
				<Tabs tabs={SECTIONS} current={tab} onSelect={go} label="Sections" />
				{bridge.subject && view !== "bridge" ? (
					<ActionButton onClick={() => go("bridge")}>Back to the bridge in progress</ActionButton>
				) : null}
			</div>
			{view === "bridge" && bridge.subject ? <BridgeScreen /> : view === "exits" ? <ExitsScreen /> : <Home />}
			<p className="max-w-prose text-meta text-ink-3">{RECOVERY_PLAIN}</p>
		</main>
	)
}

export function AppRoot({ source, frame = nextFrame, poll = 6_000 }: Props) {
	const [client] = useState(
		() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchInterval: poll, refetchOnWindowFocus: true } } }),
	)
	return (
		<QueryClientProvider client={client}>
			<AppProvider source={source} frame={frame}>
				<Shell />
			</AppProvider>
		</QueryClientProvider>
	)
}
