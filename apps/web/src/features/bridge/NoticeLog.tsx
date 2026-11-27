/** The bridge's notices, oldest first: re-proofs with the root that moved, refusals, declines. */
export function NoticeLog({ lines }: { lines: readonly string[] }) {
	if (lines.length === 0) return null
	return (
		<ul className="grid gap-1 text-meta text-ink-2" aria-label="What happened">
			{lines.map((line, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: notices repeat and keep their order.
				<li key={i}>{line}</li>
			))}
		</ul>
	)
}
