import { useApp } from "../../app/context"
import type { AztecConnection } from "../../data/wallet/types"
import { ActionButton } from "../../ui"
import { ConnectDialog } from "./ConnectDialog"

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

/** The Aztec wallet: a connect button, or the connected wallet and its accounts; the dialog runs the flow. */
export function AztecConnect() {
	const { connect, connection } = useApp()
	return (
		<>
			{connection ? (
				<Connected connection={connection} onDisconnect={() => void connect.close()} />
			) : (
				<div className="grid justify-items-start gap-3">
					<p className="text-ink-2">Connect the Aztec wallet that will hold your bridged funds.</p>
					<ActionButton variant="primary" data-testid="connect-button" onClick={() => void connect.start()}>
						Connect Aztec wallet
					</ActionButton>
				</div>
			)}
			<ConnectDialog
				step={connect.step}
				onChoose={(o) => void connect.choose(o)}
				onAnswer={connect.answerEmoji}
				onRetry={() => void connect.start()}
				onClose={() => void connect.close()}
			/>
		</>
	)
}
