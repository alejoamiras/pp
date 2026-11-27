import { useApp } from "../../app/context"
import type { BridgeMachine } from "../../data/bridge-machine"
import { ActionButton, Callout, formatAmount, LabelCrossing, Panel } from "../../ui"
import { BridgeForm } from "./BridgeForm"
import { InFlight } from "./InFlight"

const PROVING = new Set(["starting", "preflight", "proving"])
const STEP_NUMBER: Record<string, number> = { prepared: 1, submitted: 2, mined: 3, claimable: 4, claiming: 5, claimed: 6 }

function modeOf(m: BridgeMachine): "form" | "proving" | "flight" {
	const before = m.step === "preparing" || m.failure?.during === "preparing"
	if (!before) return "flight"
	return m.attempt !== null && PROVING.has(m.phase) && !m.failure ? "proving" : "form"
}

/** Compositor-only motion (the crossing's runner) and static text, so it holds while proving blocks the main thread. */
function ProvingPause({ label }: { label: bigint | undefined }) {
	return (
		<div className="grid gap-4" data-testid="proving">
			{label !== undefined ? (
				<LabelCrossing label={label} state="moving" fromNote="Proving in this browser" toNote="Arrives when claimed" />
			) : null}
			<Callout
				tone="wait"
				busy
				role="status"
				title="Proving — the page may pause for a few seconds; the first use downloads about 21 MB"
			>
				Nothing is sent until the proof is ready and your Ethereum wallet asks you.
			</Callout>
		</div>
	)
}

function eyebrow(m: BridgeMachine, mode: ReturnType<typeof modeOf>): string {
	if (mode !== "flight") return "Bridge to Aztec"
	if (m.step === "claimed") return "Bridge complete"
	const n = STEP_NUMBER[m.failure?.during ?? (m.step as string)] ?? 1
	return `Bridge in progress · step ${n} of 6`
}

export function BridgeScreen() {
	const { bridge, source, go } = useApp()
	const { machine: m, subject } = bridge
	const { decimals, symbol } = source.deployment
	const mode = modeOf(m)
	const note = subject?.note ?? null
	const amount = subject?.amount ?? null
	const stepKey = typeof m.step === "object" ? "failed" : m.step
	return (
		<Panel data-testid="bridge-screen" data-step={stepKey} data-phase={m.phase}>
			<div className="mb-4 flex flex-wrap items-start justify-between gap-3">
				<div>
					<p className="text-cap font-bold tracking-[0.06em] text-ink-3 uppercase">{eyebrow(m, mode)}</p>
					<h2 className="mt-1 text-2xl font-bold tracking-[-0.02em] sm:text-[2rem]">
						{amount !== null && mode !== "form" ? `${formatAmount(amount, decimals)} ${symbol} to Aztec` : "Bridge to Aztec"}
					</h2>
					{note ? (
						<p className="text-meta text-ink-3">
							From the {formatAmount(note.value, decimals)} {symbol} note.
							{amount !== null && mode !== "form"
								? ` ${formatAmount(note.value - amount, decimals)} stays in the pool under the same label.`
								: ""}
						</p>
					) : null}
				</div>
				<ActionButton onClick={() => go("home")}>Back to balances</ActionButton>
			</div>
			{mode === "form" && note ? <BridgeForm note={note} /> : null}
			{mode === "proving" ? <ProvingPause label={note?.label} /> : null}
			{mode === "flight" ? <InFlight /> : null}
		</Panel>
	)
}
