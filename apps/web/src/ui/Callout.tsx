import type { ReactNode } from "react"
import { type Tone, tone as toneOf } from "./tone"

interface Props {
	tone: Tone
	/** Small capitals above the title, such as "Next, you". */
	eyebrow?: string
	title?: string
	/** A spinner beside the text: something is happening and needs no action. */
	busy?: boolean
	/** 0–1; a bar under the text. */
	progress?: number
	role?: "alert" | "status"
	children?: ReactNode
}

/** The bar fills by `scaleX`, a compositor-only change, so it stays smooth while the main thread is busy. */
function ProgressBar({ value, label }: { value: number; label: string }) {
	const v = Math.min(Math.max(value, 0), 1)
	return (
		<div
			className="mt-2 h-[5px] overflow-hidden rounded-full bg-track"
			role="progressbar"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.round(v * 100)}
		>
			<div className="h-full origin-left rounded-full bg-current transition-transform" style={{ transform: `scaleX(${v})` }} />
		</div>
	)
}

export function Callout({ tone, eyebrow, title, busy = false, progress, role, children }: Props) {
	const t = toneOf({ tone })
	return (
		<div className={`flex items-start gap-3 rounded-card border px-3.5 py-3 ${t.ground()} ${t.border()}`} role={role}>
			{busy ? (
				<span
					className={`mt-px size-[18px] flex-none animate-spin rounded-full border-[2.5px] border-track border-t-current motion-reduce:animate-none ${t.ink()}`}
					aria-hidden="true"
				/>
			) : null}
			<div className="grid min-w-0 flex-1 gap-0.5">
				{eyebrow ? <p className={`text-cap font-extrabold tracking-[0.06em] uppercase ${t.ink()}`}>{eyebrow}</p> : null}
				{title ? <p className="font-bold text-ink">{title}</p> : null}
				{children ? <div className="text-meta text-ink-2">{children}</div> : null}
				{progress === undefined ? null : (
					<div className={t.ink()}>
						<ProgressBar value={progress} label={title ?? eyebrow ?? "Progress"} />
					</div>
				)}
			</div>
		</div>
	)
}
