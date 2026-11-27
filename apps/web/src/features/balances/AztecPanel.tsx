import { useApp } from "../../app/context"
import { useAllowList, useBalances, usePublicBalance } from "../../app/queries"
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

function AllowListLine() {
	const { source } = useApp()
	const allow = useAllowList(source, true)
	if (allow.isError) return <StateBadge tone="bad">Allow list unreadable: refresh to try again</StateBadge>
	if (!allow.data) return <StateBadge tone="neutral">Reading the allow list</StateBadge>
	const { record } = allow.data.view
	return (
		<span data-testid="allow-list-age">
			<StateBadge tone="ok">{`Allow list #${record.sequence} posted ${chainAge(record.rootTime, allow.data.nowSec).text}`}</StateBadge>
		</span>
	)
}

function PrivateBalances({ account, onAction }: { account: AztecAddress; onAction(a: HomeAction): void }) {
	const { source, aztec, refusal, refresh } = useApp()
	const refused = refusal("balances")
	const balances = useBalances(aztec, account, refused === null)
	const allow = useAllowList(source, true)
	if (refused)
		return (
			<Callout tone="attn" title="Your balances are hidden from this page">
				{messageOf(refused)}
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
					onCheckAgain={refresh}
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
	const { aztec, refusal, refresh } = useApp()
	const pub = usePublicBalance(aztec, account, refusal("publicBalance") === null)
	return (
		<div className="mt-4 grid gap-2">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<AllowListLine />
				<ActionButton onClick={refresh}>Refresh</ActionButton>
			</div>
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
