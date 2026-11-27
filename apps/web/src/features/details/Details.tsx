import { useState } from "react"
import { useApp } from "../../app/context"
import { RECOVERY_PRECISE } from "../../app/copy"
import { useLive } from "../../app/live"
import { useAllowList } from "../../app/queries"
import type { AztecAction } from "../../data/capabilities"
import { chainName } from "../../data/chain"
import { chainAge, bridgeView } from "../../data/model"
import { ActionButton, Callout, DetailsDrawer, type Fact, Facts } from "../../ui"
import { NoticeLog } from "../bridge/NoticeLog"

const ACTIONS: { action: AztecAction; name: string }[] = [
	{ action: "balances", name: "Read balances" },
	{ action: "claim", name: "Claim a bridge" },
	{ action: "ragequit", name: "Leave to Ethereum (ragequit)" },
	{ action: "transferPrivate", name: "Send privately" },
	{ action: "unshield", name: "Unshield" },
	{ action: "exitPublic", name: "Withdraw to Ethereum" },
	{ action: "shield", name: "Shield" },
]

const H3 = "text-cap font-bold tracking-[0.06em] text-ink-3 uppercase"

/** Backticks mark code in the copy. */
function WithCode({ text }: { text: string }) {
	return (
		<>
			{text.split("`").map((part, i) =>
				i % 2 === 1 ? (
					<code key={part} className="font-mono">
						{part}
					</code>
				) : (
					part
				),
			)}
		</>
	)
}

function Deployment() {
	const { source, live, connection } = useApp()
	const { owner, account } = useLive(live)
	const d = source.deployment
	const facts: Fact[] = [
		{ key: "chain", term: "Ethereum network", value: chainName(d.chainId) },
		{ key: "stage", term: "Token stage", value: d.stage },
		{ key: "portal", term: "Portal (Ethereum)", value: d.portal, mono: true },
		{ key: "hub", term: "Bridge hub (Aztec)", value: d.hub, mono: true },
		{ key: "token", term: "Token (Aztec)", value: d.token, mono: true },
		{ key: "owner", term: "Pool owner", value: owner ?? "Not signed in", mono: owner !== null },
		{ key: "sender", term: "Selected Ethereum account", value: account ?? "None", mono: account !== null },
		{ key: "aztec", term: "Aztec account", value: connection?.accounts[0] ?? "Not connected", mono: connection !== null },
	]
	return <Facts facts={facts} />
}

function Grant() {
	const { refusal, connection } = useApp()
	if (!connection) return <p className="text-meta text-ink-3">No Aztec wallet is connected.</p>
	return (
		<ul className="grid gap-1 text-meta text-ink-2">
			{ACTIONS.map((a) => (
				<li key={a.action}>
					{a.name}: {refusal(a.action) === null ? "allowed" : "not allowed"}
				</li>
			))}
		</ul>
	)
}

function AllowList() {
	const { source } = useApp()
	const allow = useAllowList(source, true).data
	if (!allow) return <p className="text-meta text-ink-3">Not read yet.</p>
	const { record } = allow.view
	return (
		<Facts
			facts={[
				{ key: "seq", term: "Sequence", value: `#${record.sequence}` },
				{ key: "age", term: "Posted", value: chainAge(record.rootTime, allow.nowSec).text },
				{ key: "pool", term: "Pool root", value: `0x${record.poolRoot.toString(16)}`, mono: true },
				{ key: "birth", term: "Birth root", value: `0x${record.birthRoot.toString(16)}`, mono: true },
			]}
		/>
	)
}

function Forget() {
	const { forget } = useApp()
	const [asking, setAsking] = useState(false)
	if (!asking) return <ActionButton onClick={() => setAsking(true)}>Forget this device</ActionButton>
	return (
		<Callout tone="attn" title="Forget this device?">
			<p>
				This signs out, disconnects your Aztec wallet and deletes the bridge records this browser keeps. A bridge already on
				Ethereum can be picked up again from your signature and the chain. A bridge your wallet has not sent yet is forgotten: if it
				was sent after all, bridging that note again may revert and cost gas.
			</p>
			<div className="mt-2 flex gap-2">
				<ActionButton variant="primary" onClick={() => void forget().then(() => setAsking(false))}>
					Forget
				</ActionButton>
				<ActionButton onClick={() => setAsking(false)}>Keep</ActionButton>
			</div>
		</Callout>
	)
}

export function DetailsButton() {
	const { bridge } = useApp()
	const log = bridgeView(bridge.machine).log
	return (
		<DetailsDrawer title="Details" description="What this page is connected to and allowed to do." triggerLabel="Details">
			<section className="grid gap-2">
				<h3 className={H3}>Deployment and accounts</h3>
				<Deployment />
			</section>
			<section className="grid gap-2">
				<h3 className={H3}>What the Aztec wallet allows</h3>
				<Grant />
			</section>
			<section className="grid gap-2">
				<h3 className={H3}>Allow list</h3>
				<AllowList />
			</section>
			<section className="grid gap-2">
				<h3 className={H3}>Bridge log</h3>
				{log.length === 0 ? <p className="text-meta text-ink-3">Nothing yet.</p> : <NoticeLog lines={log} />}
			</section>
			<section className="grid gap-2">
				<h3 className={H3}>Recovery</h3>
				<p className="text-meta text-ink-2" data-testid="recovery-precise">
					<WithCode text={RECOVERY_PRECISE} />
				</p>
			</section>
			<section className="grid gap-2">
				<h3 className={H3}>This device</h3>
				<Forget />
			</section>
		</DetailsDrawer>
	)
}
