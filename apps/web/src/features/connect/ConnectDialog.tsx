import type { WalletOption } from "../../data/wallet/types"
import { ActionButton, Callout, Modal } from "../../ui"
import type { ConnectStep } from "./useConnect"

interface Props {
	step: ConnectStep
	onChoose(option: WalletOption): void
	onAnswer(matches: boolean): void
	onRetry(): void
	onClose(): void
}

type Discovering = Extract<ConnectStep, { kind: "discovering" }>

function discoveryNote(step: Discovering): string {
	if (!step.done) return "Looking for wallets…"
	return step.options.length > 0 ? "Search finished." : "No wallet answered. Open your wallet, then search again."
}

function WalletList({ step, onChoose }: { step: Discovering; onChoose: Props["onChoose"] }) {
	return (
		<div className="flex flex-col gap-2">
			{step.options.map((o) => (
				<ActionButton key={o.key} block data-testid="wallet-option" data-wallet-id={o.id} onClick={() => onChoose(o)}>
					{o.name}
					<span className="font-normal text-ink-3">{o.kind === "web" ? "Web wallet" : "Extension"}</span>
				</ActionButton>
			))}
			<p data-testid="discovery-status" data-done={step.done} className="text-meta text-ink-3">
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
					<li key={i} data-testid="emoji-cell" className="rounded-control border border-edge bg-glass-2 py-1 text-center">
						{e}
					</li>
				))}
			</ol>
			<div className="flex gap-2">
				<ActionButton variant="primary" data-testid="emoji-confirm" onClick={() => onAnswer(true)}>
					They match
				</ActionButton>
				<ActionButton data-testid="emoji-reject" onClick={() => onAnswer(false)}>
					They differ
				</ActionButton>
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
			<div className="flex flex-col items-start gap-3">
				<Callout tone="bad" title="The wallet did not connect">
					<p data-testid="connect-error" role="alert">
						{step.message}
					</p>
				</Callout>
				<ActionButton variant="primary" data-testid="connect-retry" onClick={onRetry}>
					Search again
				</ActionButton>
			</div>
		)
	}
	return (
		<Callout tone="wait" busy>
			<p data-testid="connect-waiting">{WAITING[step.kind] ?? ""}</p>
		</Callout>
	)
}

export function ConnectDialog(props: Props) {
	const open = props.step.kind !== "idle" && props.step.kind !== "connected"
	return (
		<Modal
			open={open}
			onOpenChange={(next) => !next && props.onClose()}
			title="Connect an Aztec wallet"
			description="This step asks only to see your account addresses."
			data-testid="connect-dialog"
			data-step={props.step.kind}
		>
			<Body {...props} />
			<div className="flex justify-end">
				<ActionButton data-testid="connect-cancel" onClick={() => props.onClose()}>
					Cancel
				</ActionButton>
			</div>
		</Modal>
	)
}
