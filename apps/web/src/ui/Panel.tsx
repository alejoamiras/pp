import type { ComponentPropsWithoutRef, ReactNode } from "react"

type Props = Omit<ComponentPropsWithoutRef<"section">, "title" | "className"> & {
	title?: string
	subtitle?: string
	/** Right of the title, e.g. a total. */
	aside?: ReactNode
}

/** A frosted panel; other attributes (test ids, data-*) land on the section. */
export function Panel({ title, subtitle, aside, children, ...rest }: Props) {
	return (
		<section
			{...rest}
			className="rounded-panel border border-rim bg-glass p-4 shadow-(--shadow-glass) backdrop-blur-glass backdrop-saturate-140 sm:p-5"
		>
			{title ? (
				<header className="mb-3 flex items-start justify-between gap-3">
					<div>
						<h2 className="text-title font-bold tracking-[-0.01em]">{title}</h2>
						{subtitle ? <p className="text-meta text-ink-3">{subtitle}</p> : null}
					</div>
					{aside}
				</header>
			) : null}
			{children}
		</section>
	)
}
