import { tv } from "tailwind-variants/lite"
import { LabelChip } from "./LabelChip"

/** `moving` animates the runner; `stopped` holds it mid-track in the failure tone; `arrived` fills the track. */
export type CrossingState = "moving" | "stopped" | "arrived"

const track = tv({
	slots: {
		rail: "relative h-10 w-0.5 @3xl:h-0.5 @3xl:w-full",
		lane: "pointer-events-none absolute inset-0",
		runner: "absolute top-0 left-1/2 size-3 -translate-1/2 rounded-full ring-[5px] @3xl:top-1/2 @3xl:left-0",
	},
	variants: {
		state: {
			moving: {
				rail: "track-dashed-y @3xl:track-dashed-x",
				lane: "animate-travel-y motion-reduce:animate-none motion-reduce:translate-y-1/2 @3xl:animate-travel-x @3xl:motion-reduce:translate-x-1/2 @3xl:motion-reduce:translate-y-0",
				runner: "bg-tone-wait ring-tone-wait-bg",
			},
			stopped: {
				rail: "track-dashed-y @3xl:track-dashed-x",
				lane: "translate-y-1/2 @3xl:translate-x-1/2 @3xl:translate-y-0",
				runner: "bg-tone-bad ring-tone-bad-bg",
			},
			arrived: { rail: "bg-tone-ok", lane: "hidden" },
		},
	},
})

function Side({ name, label, note, ghost }: { name: string; label: bigint; note: string; ghost: boolean }) {
	return (
		<div className="grid w-full justify-items-center gap-1.5 rounded-card border border-edge bg-glass-2 p-3">
			<span className="text-xs font-bold text-ink-2">{name}</span>
			<LabelChip label={label} ghost={ghost} />
			<span className="text-xs text-ink-3">{note}</span>
		</div>
	)
}

interface Props {
	label: bigint
	state: CrossingState
	/** Under the pool side, e.g. when it was sent (chain time). */
	fromNote: string
	/** Under the Aztec side, e.g. "Arrives when claimed". */
	toNote: string
}

/** One label leaving the pool and arriving on Aztec; the Aztec chip stays dashed until it arrives. */
export function LabelCrossing({ label, state, fromNote, toNote }: Props) {
	const t = track({ state })
	return (
		<div className="@container">
			<div className="grid justify-items-center gap-2.5 @3xl:grid-cols-[1fr_160px_1fr] @3xl:items-center">
				<Side name="Pool (Ethereum)" label={label} note={fromNote} ghost={false} />
				<div className={t.rail()} aria-hidden="true">
					<span className={t.lane()}>
						<span className={t.runner()} />
					</span>
				</div>
				<Side name="Aztec" label={label} note={toNote} ghost={state !== "arrived"} />
			</div>
			<p className="mt-2 flex items-center justify-center gap-2 text-ui font-semibold text-tone-ok">
				<span className="grid size-[18px] place-items-center rounded-full bg-tone-ok-bg text-cap" aria-hidden="true">
					✓
				</span>
				Same label on both sides
			</p>
		</div>
	)
}
