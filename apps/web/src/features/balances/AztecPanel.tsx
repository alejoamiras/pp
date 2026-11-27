import { useApp } from "../../app/context"
import { useAllowList, useAllowListProgress, useBalances, usePublicBalance } from "../../app/queries"
import type { AztecAddress } from "../../data/stack-types"
import { messageOf } from "../../data/errors"
import { chainAge } from "../../data/model"
import type { LabelBalance } from "../../data/ports"
import { ActionButton, Amount, Callout, EmptyState, Panel, StateBadge, shortHex } from "../../ui"
import { AztecConnect } from "../connect/AztecConnect"
import { type LabelAction, LabelRow } from "./LabelRow"
import { type PublicAction, PublicRow } from "./PublicRow"

export type HomeAction = { kind: LabelAction; balance: LabelBalance } | { kind: PublicAction; amount: bigint }

const CAP = "text-cap font-bold tracking-[0.06em] text-ink-3 uppercase"

// A grant drops a contract whole when any of its asked scopes is missing, so a wallet that left out one
// token method withholds every read and send on the token until the whole request is granted again.
const PARTIAL_GRANT =
	"Your Aztec wallet allowed only part of what this page asked for on the token contract, so the page can neither read nor move your token here. Nothing is lost: disconnect, connect again, and allow the whole request."

/** The tree build a check is running, with the only way to stop it. */
function AllowListProgressLine() {
	const { source } = useApp()
	const p = useAllowListProgress(source)
	if (p === null) return null
	return (
		<span data-testid="allow-list-progress" className="flex flex-wrap items-center gap-2 text-meta text-ink-2" role="status">
			{p.total === 0
				? "Checking the allow list…"
				: `Checking the allow list: ${p.hashed.toLocaleString("en")} of ${p.total.toLocaleString("en")} hashed`}
			<ActionButton onClick={() => source.allowList.cancel()}>Cancel</ActionButton>
		</span>
	)
}

function AllowListLine() {
	const { source } = useApp()
	const allow = useAllowList(source, true)
	if (allow.isError) return <StateBadge tone="bad">Allow list unreadable: refresh to try again</StateBadge>
	if (!allow.data) return <StateBadge tone="neutral">Reading the allow list</StateBadge>
	const { record, nowSec } = allow.data
	return (
		<span data-testid="allow-list-age">
			<StateBadge tone="ok">{`Allow list #${record.sequence} posted ${chainAge(record.rootTime, nowSec).text}`}</StateBadge>
		</span>
	)
}

function PrivateBalances({ account, onAction }: { account: AztecAddress; onAction(a: HomeAction): void }) {
	const { source, aztec, refusal, refresh } = useApp()
	const refused = refusal("balances")
	const balances = useBalances(aztec, account, refused === null)
	const allow = useAllowList(source, true)
	const checkAgain = () => {
		if (allow.data) source.allowList.checkAgain(allow.data)
		refresh()
	}
	if (refused)
		return (
			<Callout tone="attn" title="Your balances are hidden from this page">
				{refused === "NOT_GRANTED" ? PARTIAL_GRANT : messageOf(refused)}
			</Callout>
		)
	if (balances.isPending) return <Callout tone="wait" busy role="status" title="Reading your private balances…" />
	if (balances.isError)
		return (
			<Callout tone="bad" title="We could not read your private balances" role="alert">
				<p>Check that your Aztec wallet is open, then try again.</p>
				<div className="mt-2">
					<ActionButton onClick={() => void balances.refetch()}>Try again</ActionButton>
				</div>
			</Callout>
		)
	if (balances.data.length === 0)
		return <EmptyState title="No private balance on this account yet">Bridge a note from the pool to start.</EmptyState>
	return (
		<ul className="grid gap-2">
			{balances.data.map((b) => (
				<LabelRow
					key={`${b.label}:${b.origin}`}
					balance={b}
					allow={allow.data}
					onAction={(kind, balance) => onAction({ kind, balance })}
					onCheckAgain={checkAgain}
				/>
			))}
		</ul>
	)
}

function PrivateTotal({ account }: { account: AztecAddress }) {
	const { source, aztec, refusal } = useApp()
	const balances = useBalances(aztec, account, refusal("balances") === null).data
	if (!balances) return null
	const total = balances.reduce((sum, b) => sum + b.balance, 0n)
	return <Amount value={total} decimals={source.deployment.decimals} symbol={source.deployment.symbol} qualifier="private" size="total" />
}

function Balances({ account, onAction }: { account: AztecAddress; onAction(a: HomeAction): void }) {
	const { aztec, refusal, refresh, tx } = useApp()
	const pub = usePublicBalance(aztec, account, refusal("publicBalance") === null)
	// The one place a held send is read again: a hold ends only on a Refresh the user makes.
	const reread = () => {
		void tx.check()
		refresh()
	}
	return (
		<div className="mt-4 grid gap-2">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<AllowListLine />
				<ActionButton onClick={reread}>Refresh</ActionButton>
			</div>
			<AllowListProgressLine />
			<p className={CAP}>Private, by label</p>
			<PrivateBalances account={account} onAction={onAction} />
			<p className={CAP}>Public</p>
			<PublicRow amount={pub.data} onAction={(kind, amount) => onAction({ kind, amount })} />
		</div>
	)
}

export function AztecPanel({ onAction }: { onAction(a: HomeAction): void }) {
	const { connect, connection } = useApp()
	const account = connection?.accounts[0] ?? null
	return (
		<Panel
			data-testid="connect-panel"
			data-state={connect.step.kind}
			title="Aztec"
			subtitle={account ? shortHex(account) : "Private balances, by label."}
			aside={account ? <PrivateTotal account={account} /> : undefined}
		>
			<AztecConnect />
			{account ? <Balances account={account} onAction={onAction} /> : null}
		</Panel>
	)
}
