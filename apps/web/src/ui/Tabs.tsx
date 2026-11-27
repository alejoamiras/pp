interface Tab<K extends string> {
	key: K
	label: string
}

/** The page's own sections as a row of toggle buttons; the current one carries `aria-current="page"`. */
export function Tabs<K extends string>({
	tabs,
	current,
	onSelect,
	label,
}: {
	tabs: readonly Tab<K>[]
	current: K | null
	onSelect(key: K): void
	label: string
}) {
	return (
		<nav aria-label={label} className="flex gap-1 rounded-full border border-rim bg-glass p-1 backdrop-blur-glass">
			{tabs.map((t) => (
				<button
					key={t.key}
					type="button"
					aria-current={t.key === current ? "page" : undefined}
					onClick={() => onSelect(t.key)}
					className="cursor-pointer rounded-full px-3 py-1.5 text-meta font-semibold text-ink-2 aria-[current=page]:bg-action aria-[current=page]:text-action-ink focus-visible:outline-2 focus-visible:outline-ink"
				>
					{t.label}
				</button>
			))}
		</nav>
	)
}

/** A connected account as a frosted pill: what it is, then the short address. */
export function ConnectionPill({ name, value, title }: { name: string; value: string; title?: string }) {
	return (
		<span
			className="inline-flex items-center gap-1.5 rounded-full border border-rim bg-glass px-2.5 py-[7px] font-mono text-xs leading-none font-medium backdrop-blur-glass"
			title={title}
		>
			<span className="font-sans font-semibold text-ink-3">{name}</span>
			{value}
		</span>
	)
}
