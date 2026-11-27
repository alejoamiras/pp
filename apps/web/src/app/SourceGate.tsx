import { useCallback, useEffect, useState } from "react"
import { codeOf, messageOf } from "../data/errors"
import type { DataSource } from "../data/source"
import { ActionButton, Callout } from "../ui"
import { AppRoot } from "./AppRoot"

type Load = { source: DataSource } | { failed: string } | null

/** Renders the app once `load` gives the build's data source; a failed load says why and offers to read again. */
export function SourceGate({ load }: { load: () => Promise<DataSource> }) {
	const [state, setState] = useState<Load>(null)
	const start = useCallback(() => {
		setState(null)
		load().then(
			(source) => setState({ source }),
			(err: unknown) => setState({ failed: messageOf(codeOf(err) ?? "RPC_FAILED") }),
		)
	}, [load])
	useEffect(start, [start])
	if (state !== null && "source" in state) return <AppRoot source={state.source} />
	return (
		<main className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-6 sm:py-8">
			{state === null ? (
				<Callout tone="wait" busy title="Reading the deployment from Ethereum" role="status" />
			) : (
				<Callout tone="bad" title="The page could not read the deployment" role="alert">
					<p>{state.failed}</p>
					<ActionButton onClick={start}>Read it again</ActionButton>
				</Callout>
			)}
		</main>
	)
}
