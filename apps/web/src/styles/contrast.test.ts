/**
 * WCAG contrast of every text/ground pair the components draw, read straight from theme.css so the
 * tokens and this check cannot drift. Translucent colours are composited over the surface token.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const CSS = readFileSync(new URL("./theme.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")

const TONES = ["ok", "wait", "attn", "bad"] as const

/** [text token, ground token, where it is drawn] */
const PAIRS: readonly (readonly [string, string, string])[] = [
	["ink", "surface", "body and dialog text"],
	["ink-2", "surface", "secondary text"],
	["ink-3", "surface", "muted text, disabled actions and their reasons"],
	["ink", "glass-2", "chip and row text"],
	["ink-2", "glass-2", "neutral badge, event detail, no-label chip"],
	["ink-3", "glass-2", "muted text in a row, a step still to come"],
	["ink-2", "glass", "section tabs"],
	["ink-3", "glass", "connection pill name"],
	["action-ink", "action", "primary button, current tab"],
	["id", "id-bg", "label glyph"],
	...TONES.flatMap((t) => [
		[`tone-${t}`, `tone-${t}-bg`, `${t} badge, step marker, callout eyebrow`] as const,
		[`tone-${t}`, "surface", `${t} step note, the same-label line`] as const,
		["ink", `tone-${t}-bg`, `${t} callout title`] as const,
		["ink-2", `tone-${t}-bg`, `${t} callout body`] as const,
	]),
]

/** The body of the block opened by the first `{` after `head`, braces balanced. */
function block(css: string, head: string): string {
	const at = css.indexOf(head)
	if (at < 0) throw new Error(`theme.css has no ${head}`)
	const open = css.indexOf("{", at + head.length)
	let depth = 0
	for (let i = open; i < css.length; i++) {
		if (css[i] === "{") depth++
		if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i)
	}
	throw new Error(`unbalanced block after ${head}`)
}

function tokens(body: string): Record<string, string> {
	return Object.fromEntries([...body.matchAll(/--color-([\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]))
}

type Rgb = readonly [number, number, number]

function parse(colour: string, over: Rgb): Rgb {
	const hex = /^#([0-9a-f]{6})$/i.exec(colour)
	if (hex) {
		const channel = (i: number) => Number.parseInt(hex[1].slice(i, i + 2), 16)
		return [channel(0), channel(2), channel(4)]
	}
	const fn = /^rgba?\(([^)]+)\)$/.exec(colour)
	if (!fn) throw new Error(`unsupported colour ${colour}`)
	const [r, g, b, a = 1] = fn[1].split(",").map(Number)
	const mix = (v: number, i: number) => v * a + over[i] * (1 - a)
	return [mix(r, 0), mix(g, 1), mix(b, 2)]
}

function luminance(c: Rgb): number {
	const [r, g, b] = c.map((v) => {
		const s = v / 255
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
	})
	return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function ratio(theme: Record<string, string>, text: string, ground: string): number {
	const surface = parse(theme.surface, [255, 255, 255])
	const [hi, lo] = [luminance(parse(theme[text], surface)), luminance(parse(theme[ground], surface))].sort((p, q) => q - p)
	return (hi + 0.05) / (lo + 0.05)
}

const light = tokens(block(CSS, "@theme static"))
const forcedDark = tokens(block(CSS, ':root[data-theme="dark"]'))
const preferredDark = tokens(block(block(CSS, "@media (prefers-color-scheme: dark)"), ':root:not([data-theme="light"])'))
const THEMES = { light, dark: { ...light, ...forcedDark } }

describe("theme contrast", () => {
	it("gives the OS dark preference exactly the forced dark tokens, covering every light colour", () => {
		expect(preferredDark).toEqual(forcedDark)
		expect(Object.keys(forcedDark).sort()).toEqual(Object.keys(light).sort())
	})

	it.each(Object.entries(THEMES))("meets 4.5:1 for every declared pair in %s", (_, theme) => {
		const weak = PAIRS.filter(([text, ground]) => !(ratio(theme, text, ground) >= 4.5)).map(
			([text, ground, where]) => `${text} on ${ground} (${where}): ${ratio(theme, text, ground).toFixed(2)}`,
		)
		expect(weak).toEqual([])
	})
})
