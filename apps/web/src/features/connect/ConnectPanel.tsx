import type { DataSource } from "../../data/source"
import type { AztecConnection } from "../../data/wallet/types"
import { ActionButton, Panel } from "../../ui"
import { ConnectDialog } from "./ConnectDialog"
import { useConnect } from "./useConnect"

function Connected({ connection, onDisconnect }: { connection: AztecConnection; onDisconnect(): void }) {
	return (
		<div className="flex flex-col items-start gap-3">
			<p className="text-ink-2">
				Connected to{" "}
				<span data-testid="aztec-wallet-name" className="font-semibold text-ink">
					{connection.walletName}
				</span>
			</p>
			<ul className="flex w-full flex-col gap-1.5">
				{connection.accounts.map((a) => (
					<li
						key={a}
						data-testid="aztec-account"
						data-address={a}
						className="rounded-row border border-edge bg-glass-2 px-3 py-2 font-mono text-meta break-all"
					>
						{a}
					</li>
				))}
			</ul>
			<ActionButton data-testid="disconnect-button" onClick={onDisconnect}>
				Disconnect
			</ActionButton>
		</div>
	)
}

export function ConnectPanel({ source }: { source: DataSource }) {
	const { step, start, choose, answerEmoji, close } = useConnect(source)
	const connected = step.kind === "connected" ? step.connection : null
	return (
		<Panel data-testid="connect-panel" data-state={step.kind} title="Aztec" subtitle="Private balances, by label.">
			{connected ? (
				<Connected connection={connected} onDisconnect={() => void close()} />
			) : (
				<ActionButton variant="primary" data-testid="connect-button" onClick={() => void start()}>
					Connect Aztec wallet
				</ActionButton>
			)}
			<ConnectDialog
				step={step}
				onChoose={(o) => void choose(o)}
				onAnswer={answerEmoji}
				onRetry={() => void start()}
				onClose={() => void close()}
			/>
		</Panel>
	)
}
