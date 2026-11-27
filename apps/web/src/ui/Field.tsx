import { type ComponentPropsWithoutRef, type ReactNode, useId } from "react"

type Props = Omit<ComponentPropsWithoutRef<"input">, "className" | "id" | "onChange" | "value"> & {
	label: string
	value: string
	onValue(value: string): void
	/** Under the input while there is no error. */
	hint?: ReactNode
	/** Replaces the hint and marks the input invalid; it should say what to type instead. */
	error?: string
	/** Right of the input, e.g. a "Whole note" button. */
	aside?: ReactNode
}

/** A labelled text input; the hint or error is tied to it by `aria-describedby`. */
export function Field({ label, value, onValue, hint, error, aside, ...rest }: Props) {
	const id = useId()
	const noteId = `${id}-note`
	const note = error ?? hint
	return (
		<div className="grid gap-1.5">
			<label htmlFor={id} className="text-xs font-bold text-ink-2">
				{label}
			</label>
			<div className="flex items-center gap-2">
				<input
					{...rest}
					id={id}
					value={value}
					onChange={(e) => onValue(e.target.value)}
					aria-invalid={error ? true : undefined}
					aria-describedby={note ? noteId : undefined}
					autoComplete="off"
					spellCheck={false}
					className="min-w-0 flex-1 rounded-control border border-edge bg-glass-2 px-3 py-2 font-mono text-ui text-ink outline-none focus-visible:border-ink aria-invalid:border-tone-bad"
				/>
				{aside}
			</div>
			{note ? (
				<p id={noteId} className={error ? "text-xs text-tone-bad" : "text-xs text-ink-3"} role={error ? "alert" : undefined}>
					{note}
				</p>
			) : null}
		</div>
	)
}
