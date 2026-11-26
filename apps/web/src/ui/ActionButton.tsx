import { type ComponentPropsWithRef, useId } from "react"
import { tv } from "tailwind-variants/lite"

const button = tv({
	base: "inline-flex cursor-pointer items-center gap-[7px] rounded-control border px-[11px] py-2 text-meta leading-none font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:border-dashed disabled:border-edge disabled:bg-transparent disabled:text-ink-3",
	variants: {
		variant: {
			primary: "border-transparent bg-action text-action-ink enabled:hover:opacity-90",
			secondary: "border-edge bg-transparent text-ink enabled:hover:bg-glass-2",
		},
		block: { true: "w-full justify-between text-left", false: "w-fit" },
	},
})

type Props = Omit<ComponentPropsWithRef<"button">, "disabled" | "className" | "type"> & {
	variant?: "primary" | "secondary"
	/** Disables the button and says why in visible text tied to it by `aria-describedby`, never only in a tooltip. */
	disabledReason?: string
	/** A short marker after the text, such as "public" on an exit that reveals the label. */
	tag?: string
	/** Full width, for a list of choices. */
	block?: boolean
}

export function ActionButton({ variant = "secondary", disabledReason, tag, block = false, children, ...rest }: Props) {
	const reasonId = useId()
	const disabled = disabledReason !== undefined
	const element = (
		<button
			type="button"
			{...rest}
			disabled={disabled}
			aria-describedby={disabled ? reasonId : rest["aria-describedby"]}
			className={button({ variant, block })}
		>
			{children}
			{tag ? (
				<span className="rounded-tag bg-tone-attn-bg px-[5px] py-[3px] font-mono text-[10px] leading-none font-semibold text-tone-attn">
					{tag}
				</span>
			) : null}
		</button>
	)
	if (!disabled) return element
	return (
		<span className="inline-flex flex-col items-start gap-1">
			{element}
			<span id={reasonId} className="text-xs text-ink-3">
				{disabledReason}
			</span>
		</span>
	)
}
