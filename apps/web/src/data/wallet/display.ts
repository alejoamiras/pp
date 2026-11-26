/** Controls, format characters (bidi marks, overrides and isolates, zero-width characters, the soft
 *  hyphen, the BOM, tag characters), lone surrogates, line and paragraph separators, and the
 *  characters that render blank: the combining grapheme joiner, the Hangul fillers and the braille
 *  blank. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}ᅟᅠ⠀ㅤﾠ]|͏/gu
/** More than four combining marks on one base is a stacking attack, not a script. */
const MARK_RUN = /(\p{M}{4})\p{M}+/gu
const SPACE_RUN = /\s+/gu
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u
/** UTF-16 units of a claimed name read at all; the rest is cut before any other work. */
const INPUT_MAX = 1024
/** Output budget per kept grapheme, so one grapheme cannot carry the whole input. */
const UNITS_PER_GRAPHEME = 8
export const WALLET_NAME_MAX = 48

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/**
 * A wallet-claimed name bounded for display: invisible characters stripped, mark runs capped at four,
 * whitespace collapsed, then at most `max` graphemes and `max * 8` UTF-16 units, plus "…" when cut.
 * Returns "" when nothing visible is left. The result is still untrusted text: interpolate it only.
 */
export function sanitizeWalletName(raw: string, max: number = WALLET_NAME_MAX): string {
	const clean = raw.slice(0, INPUT_MAX).replace(INVISIBLE, "").replace(MARK_RUN, "$1").replace(SPACE_RUN, " ").trim()
	if (!VISIBLE.test(clean)) return ""
	const budget = max * UNITS_PER_GRAPHEME
	let out = ""
	let kept = 0
	for (const { segment } of graphemes.segment(clean)) {
		if (kept === max || out.length + segment.length > budget) return `${out.trimEnd()}…`
		out += segment
		kept++
	}
	return out
}
