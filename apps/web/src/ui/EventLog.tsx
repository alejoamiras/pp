import { StateBadge } from "./StateBadge"
import type { Tone } from "./tone"

export interface LogEvent {
	key: string
	/** Display time, already labelled as chain time where it is one. */
	time: string
	title: string
	/** Hashes and other long values wrap anywhere rather than widen the page. */
	detail?: string
	badge?: { tone: Tone; text: string }
}

/** Oldest first, as given. */
export function EventLog({
	events,
	label,
	emptyText = "Nothing has happened yet.",
}: {
	events: readonly LogEvent[]
	label: string
	emptyText?: string
}) {
	if (events.length === 0) return <p className="text-meta text-ink-3">{emptyText}</p>
	return (
		<ol aria-label={label} className="grid gap-2">
			{events.map((e) => (
				<li
					key={e.key}
					className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1 rounded-row border border-edge bg-glass-2 px-3 py-2.5"
				>
					<span className="font-mono text-cap text-ink-3">{e.time}</span>
					<span className="flex flex-wrap items-center gap-2 font-semibold">
						{e.title}
						{e.badge ? <StateBadge tone={e.badge.tone}>{e.badge.text}</StateBadge> : null}
					</span>
					{e.detail ? (
						<span className="col-start-2 font-mono text-meta [overflow-wrap:anywhere] text-ink-2">{e.detail}</span>
					) : null}
				</li>
			))}
		</ol>
	)
}
