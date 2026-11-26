import { Dialog } from "radix-ui"
import type { WalletOption } from "../../data/wallet/types"
import type { ConnectStep } from "./useConnect"

interface Props {
	step: ConnectStep
	onChoose(option: WalletOption): void
	onAnswer(matches: boolean): void
	onRetry(): void
	onClose(): void
}

const button = "rounded-md px-4 py-2 font-semibold disabled:opacity-50"

type Discovering = Extract<ConnectStep, { kind: "discovering" }>

function discoveryNote(step: Discovering): string {
	if (!step.done) return "Looking for wallets…"
	return step.options.length > 0 ? "Search finished." : "No wallet answered. Open your wallet, then search again."
}

function WalletList({ step, onChoose }: { step: Discovering; onChoose: Props["onChoose"] }) {
	return (
		<div className="flex flex-col gap-2">
			{step.options.map((o) => (
				<button
					key={o.key}
					type="button"
					data-testid="wallet-option"
					data-wallet-id={o.id}
					className={`${button} border border-slate-300 text-left`}
					onClick={() => onChoose(o)}
				>
					{o.name} <span className="text-sm font-normal text-slate-500">{o.kind === "web" ? "Web wallet" : "Extension"}</span>
				</button>
			))}
			<p data-testid="discovery-status" data-done={step.done} className="text-sm text-slate-500">
				{discoveryNote(step)}
			</p>
		</div>
	)
}

function EmojiCheck({ emoji, onAnswer }: { emoji: readonly string[]; onAnswer: Props["onAnswer"] }) {
	return (
		<div className="flex flex-col gap-4">
			<p>Your wallet shows nine symbols. Continue only if they are the same, in the same order.</p>
			<ol data-testid="emoji-grid" className="grid w-48 grid-cols-3 gap-2 text-3xl">
				{emoji.map((e, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: the grid's order is its meaning, and symbols repeat.
					<li key={i} data-testid="emoji-cell" className="text-center">
						{e}
					</li>
				))}
			</ol>
			<div className="flex gap-2">
				<button
					type="button"
					data-testid="emoji-confirm"
					className={`${button} bg-slate-900 text-white`}
					onClick={() => onAnswer(true)}
				>
					They match
				</button>
				<button
					type="button"
					data-testid="emoji-reject"
					className={`${button} border border-slate-300`}
					onClick={() => onAnswer(false)}
				>
					They differ
				</button>
			</div>
		</div>
	)
}

const WAITING: Partial<Record<ConnectStep["kind"], string>> = {
	opening: "Opening a secure channel to the wallet…",
	granting: "Approve the account request in your wallet.",
}

function Body({ step, onChoose, onAnswer, onRetry }: Omit<Props, "onClose">) {
	if (step.kind === "discovering") return <WalletList step={step} onChoose={onChoose} />
	if (step.kind === "verifying") return <EmojiCheck emoji={step.emoji} onAnswer={onAnswer} />
	if (step.kind === "error") {
		return (
			<div className="flex flex-col gap-4">
				<p data-testid="connect-error" role="alert">
					{step.message}
				</p>
				<button type="button" data-testid="connect-retry" className={`${button} bg-slate-900 text-white`} onClick={onRetry}>
					Search again
				</button>
			</div>
		)
	}
	return <p data-testid="connect-waiting">{WAITING[step.kind] ?? ""}</p>
}

export function ConnectDialog(props: Props) {
	const open = props.step.kind !== "idle" && props.step.kind !== "connected"
	return (
		<Dialog.Root open={open} onOpenChange={(next) => !next && props.onClose()}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 bg-slate-900/40" />
				<Dialog.Content
					data-testid="connect-dialog"
					data-step={props.step.kind}
					className="fixed top-1/2 left-1/2 flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-lg bg-white p-6 shadow-lg"
				>
					<Dialog.Title className="text-lg font-bold">Connect an Aztec wallet</Dialog.Title>
					<Dialog.Description className="text-sm text-slate-600">
						This step asks only to see your account addresses.
					</Dialog.Description>
					<Body {...props} />
					<Dialog.Close className={`${button} self-end border border-slate-300`} data-testid="connect-cancel">
						Cancel
					</Dialog.Close>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	)
}
