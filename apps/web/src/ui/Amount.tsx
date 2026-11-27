import { tv } from "tailwind-variants/lite"
import { formatAmount } from "./format"

const amount = tv({
	base: "font-bold whitespace-nowrap tabular-nums",
	variants: { size: { row: "text-base", total: "text-2xl tracking-[-0.02em]" } },
})

interface Props {
	/** Base units; never negative. */
	value: bigint
	decimals: number
	/** Already sanitised by the data layer when it comes from a chain. */
	symbol: string
	/** Fraction digits shown from 0.01 up; smaller amounts keep two significant digits. */
	places?: number
	size?: "row" | "total"
	/** A word after the symbol, such as "private". */
	qualifier?: string
}

export function Amount({ value, decimals, symbol, places = 2, size = "row", qualifier }: Props) {
	return (
		<span className={amount({ size })}>
			{formatAmount(value, decimals, places)}
			<small className="ml-1 text-cap font-semibold tracking-normal text-ink-3">
				{qualifier ? `${symbol} ${qualifier}` : symbol}
			</small>
		</span>
	)
}
