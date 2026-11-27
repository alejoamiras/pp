import { useId } from "react"

interface Choice {
	key: string
	label: string
	/** Under the label. */
	note?: string
}

interface Props {
	legend: string
	choices: readonly Choice[]
	selected: string | null
	onSelect(key: string): void
}

/** A radio list; each choice is a full-width row. */
export function Choices({ legend, choices, selected, onSelect }: Props) {
	const name = useId()
	return (
		<fieldset className="grid gap-1.5">
			<legend className="mb-1.5 text-xs font-bold text-ink-2">{legend}</legend>
			{choices.map((c) => (
				<label
					key={c.key}
					className="flex cursor-pointer items-center gap-2.5 rounded-row border border-edge bg-glass-2 px-3 py-2 has-checked:border-ink"
				>
					<input
						type="radio"
						name={name}
						value={c.key}
						checked={selected === c.key}
						onChange={() => onSelect(c.key)}
						className="accent-current"
					/>
					<span className="grid">
						<span className="font-semibold tabular-nums">{c.label}</span>
						{c.note ? <span className="text-xs text-ink-3">{c.note}</span> : null}
					</span>
				</label>
			))}
		</fieldset>
	)
}
