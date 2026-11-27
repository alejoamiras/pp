/**
 * A base-unit amount for reading: thousands grouped, the fraction cut (never rounded) to `places`.
 * A non-zero amount below the last shown place keeps its first two significant digits instead, so
 * it never reads as nothing.
 *
 *   formatAmount(1_005_000n, 6) === "1.00"
 *   formatAmount(5_000n, 6) === "0.005"
 *   formatAmount(12_345n, 9) === "0.000012"
 *
 * `value` must be non-negative and `decimals` a non-negative integer.
 */
export function formatAmount(value: bigint, decimals: number, places = 2): string {
	const lastPlace = 10n ** BigInt(Math.max(decimals - places, 0))
	if (value === 0n || value >= lastPlace) return formatFixed(value, decimals, places)
	const digits = value.toString().padStart(decimals, "0")
	const lead = digits.search(/[1-9]/)
	return `0.${digits.slice(0, Math.max(places, lead + 2)).replace(/0+$/, "")}`
}

/** Grouped whole part and the fraction truncated to `places`, trailing zeros kept so columns align. */
function formatFixed(value: bigint, decimals: number, places: number): string {
	const divisor = 10n ** BigInt(decimals)
	const whole = (value / divisor).toLocaleString("en-US")
	const fraction = decimals === 0 ? "" : (value % divisor).toString().padStart(decimals, "0").slice(0, places)
	return fraction ? `${whole}.${fraction}` : whole
}

/** The exact amount as plain decimal text, for an input: no grouping, trailing fraction zeros dropped. */
export function plainAmount(value: bigint, decimals: number): string {
	if (decimals === 0) return value.toString()
	const divisor = 10n ** BigInt(decimals)
	const fraction = (value % divisor).toString().padStart(decimals, "0").replace(/0+$/, "")
	return fraction ? `${value / divisor}.${fraction}` : `${value / divisor}`
}

/** A field element as 32-byte hex: the one spelling the glyph is seeded from. */
export function labelHex(label: bigint): string {
	return `0x${label.toString(16).padStart(64, "0")}`
}

/** `0x2f9c…a41e`: enough to tell labels apart at a glance; the glyph and the full value disambiguate. */
export function shortHex(hex: string, head = 4, tail = 4): string {
	const body = hex.startsWith("0x") ? hex.slice(2) : hex
	if (body.length <= head + tail + 1) return `0x${body}`
	return `0x${body.slice(0, head)}…${body.slice(-tail)}`
}
