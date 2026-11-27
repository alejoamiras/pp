import { useEffect, useState } from "react"
import { useApp } from "../../app/context"
import { ActionDialogs } from "../actions/ActionDialogs"
import { AztecPanel, type HomeAction } from "./AztecPanel"
import { PoolPanel } from "./PoolPanel"
import { StateKey } from "./StateKey"

/** Both sides at once: each panel shows its own connect state, so this is also the Connect screen. */
export function Home() {
	const epoch = useApp().connection?.epoch
	// An action carries amounts read under the connection that offered it; no later connection, even for
	// the same account, inherits its dialog.
	const [opened, setOpened] = useState<{ action: HomeAction; epoch: number | undefined } | null>(null)
	const action = opened !== null && opened.epoch === epoch ? opened.action : null
	useEffect(() => {
		if (opened && opened.epoch !== epoch) setOpened(null)
	}, [opened, epoch])
	return (
		<div className="@container">
			<div className="grid gap-4 @3xl:grid-cols-2 @3xl:items-start">
				<div className="grid gap-4">
					<PoolPanel />
					<StateKey />
				</div>
				<AztecPanel onAction={(a) => setOpened({ action: a, epoch })} />
			</div>
			{action ? <ActionDialogs action={action} onClose={() => setOpened(null)} /> : null}
		</div>
	)
}
