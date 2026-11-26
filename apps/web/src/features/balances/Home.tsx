import { useState } from "react"
import { ActionDialogs } from "../actions/ActionDialogs"
import { AztecPanel, type HomeAction } from "./AztecPanel"
import { PoolPanel } from "./PoolPanel"
import { StateKey } from "./StateKey"

/** Both sides at once: each panel shows its own connect state, so this is also the Connect screen. */
export function Home() {
	const [action, setAction] = useState<HomeAction | null>(null)
	return (
		<div className="@container">
			<div className="grid gap-4 @3xl:grid-cols-2 @3xl:items-start">
				<div className="grid gap-4">
					<PoolPanel />
					<StateKey />
				</div>
				<AztecPanel onAction={setAction} />
			</div>
			{action ? <ActionDialogs action={action} onClose={() => setAction(null)} /> : null}
		</div>
	)
}
