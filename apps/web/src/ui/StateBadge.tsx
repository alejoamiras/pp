import { type Tone, tone as toneOf } from "./tone"

const BASE =
	"inline-flex items-center gap-1.5 rounded-full px-2 py-1 font-mono text-cap leading-none font-semibold tracking-[0.02em] whitespace-nowrap before:size-1.5 before:rounded-full before:bg-current"

/** A state as a word on its tone; the dot is decoration, the text is the meaning. */
export function StateBadge({ tone, children }: { tone: Tone; children: string }) {
	const t = toneOf({ tone })
	return (
		<span className={`${BASE} ${t.ground()} ${t.ink()}`} data-tone={tone}>
			{children}
		</span>
	)
}
