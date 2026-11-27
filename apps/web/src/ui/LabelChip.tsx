import { tv } from "tailwind-variants/lite"
import { labelHex, shortHex } from "./format"
import { Glyph } from "./Glyph"

const chip = tv({
	base: "inline-flex items-center rounded-full border border-edge bg-glass-2 text-ui whitespace-nowrap",
	variants: {
		kind: {
			label: "gap-[7px] py-[3px] pr-2.5 pl-[3px] font-mono leading-[1.2] font-medium",
			none: "px-2.5 py-1 font-semibold text-ink-2",
		},
		ghost: { true: "border-dashed" },
	},
})

interface Props {
	/** The label as a field element; `null` is the public balance, which carries none. */
	label: bigint | null
	/** Dashed outline: the label is promised here but has not arrived. */
	ghost?: boolean
}

/** A label, shortened, with its glyph: the glyph is seeded from the full value, so two labels that shorten alike still look different. */
export function LabelChip({ label, ghost = false }: Props) {
	if (label === null) return <span className={chip({ kind: "none", ghost })}>No label</span>
	const hex = labelHex(label)
	return (
		<span className={chip({ kind: "label", ghost })} title={hex} data-label={hex}>
			<span className="grid size-[22px] place-items-center rounded-full bg-id-bg text-id">
				<Glyph seed={hex} />
			</span>
			{shortHex(hex)}
		</span>
	)
}
