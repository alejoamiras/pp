import type { ReactNode } from "react"

export interface Fact {
	key: string
	term: string
	value: ReactNode
	/** Hex and addresses: mono, wrapping anywhere rather than widening the page. */
	mono?: boolean
}

/** Term and value pairs in small glass tiles; two columns from 32rem, four with `wide`. */
export function Facts({ facts, wide = false }: { facts: readonly Fact[]; wide?: boolean }) {
	return (
		<div className="@container">
			<dl className={`grid gap-2 @lg:grid-cols-2 ${wide ? "@3xl:grid-cols-4" : ""}`}>
				{facts.map((f) => (
					<div key={f.key} className="min-w-0 rounded-control bg-glass-2 px-2.5 py-[7px]">
						<dt className="text-cap font-semibold text-ink-3">{f.term}</dt>
						<dd className={f.mono ? "font-mono text-ui [overflow-wrap:anywhere]" : "text-ui font-semibold"}>{f.value}</dd>
					</div>
				))}
			</dl>
		</div>
	)
}
