import type { ReactNode } from "react"

/** Nothing to show, said plainly, with what to do next. */
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
	return (
		<div className="grid justify-items-center gap-1.5 rounded-row border border-dashed border-edge px-4 py-6 text-center">
			<p className="font-semibold text-ink">{title}</p>
			{children ? <div className="max-w-prose text-meta text-ink-3">{children}</div> : null}
			{action}
		</div>
	)
}
