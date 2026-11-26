import type { DataSource } from "../../data/source"
import { ConnectDialog } from "./ConnectDialog"
import { useConnect } from "./useConnect"

export function ConnectPanel({ source }: { source: DataSource }) {
	const { step, start, choose, answerEmoji, close } = useConnect(source)
	const connected = step.kind === "connected" ? step.connection : null
	return (
		<section data-testid="connect-panel" data-state={step.kind} className="flex flex-col gap-3 rounded-lg border border-slate-200 p-6">
			<h2 className="text-lg font-bold">Aztec</h2>
			{connected ? (
				<>
					<p>
						Connected to <span data-testid="aztec-wallet-name">{connected.walletName}</span>
					</p>
					<ul className="flex flex-col gap-1 font-mono text-sm break-all">
						{connected.accounts.map((a) => (
							<li key={a} data-testid="aztec-account" data-address={a}>
								{a}
							</li>
						))}
					</ul>
					<button
						type="button"
						data-testid="disconnect-button"
						className="self-start rounded-md border border-slate-300 px-4 py-2"
						onClick={close}
					>
						Disconnect
					</button>
				</>
			) : (
				<button
					type="button"
					data-testid="connect-button"
					className="self-start rounded-md bg-slate-900 px-4 py-2 font-semibold text-white"
					onClick={() => void start()}
				>
					Connect Aztec wallet
				</button>
			)}
			<ConnectDialog
				step={step}
				onChoose={(o) => void choose(o)}
				onAnswer={answerEmoji}
				onRetry={() => void start()}
				onClose={() => void close()}
			/>
		</section>
	)
}
