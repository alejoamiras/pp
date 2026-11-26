import { labelView } from "../../data/labels"
import { StateBadge } from "../../ui"

const KEYS = [labelView(0, "ACTIVE"), labelView(1, "ABSENT"), labelView(0, "ABSENT"), labelView(0, "STALE_ROOT")]

/** What each label state means, so no state is read from its colour. */
export function StateKey() {
	return (
		<section aria-label="Label states" className="rounded-card border border-rim bg-glass px-3.5 py-3 text-meta text-ink-2">
			<ul className="grid gap-2">
				{KEYS.map((k) => (
					<li key={k.text} className="grid gap-1 sm:grid-cols-[11rem_1fr] sm:items-baseline sm:gap-2.5">
						<span>
							<StateBadge tone={k.tone}>{k.text}</StateBadge>
						</span>
						<span>{k.meaning}</span>
					</li>
				))}
			</ul>
		</section>
	)
}
