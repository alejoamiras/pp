/**
 * Only src/ui and src/styles know the look. Everywhere else in src, a colour literal, an arbitrary
 * or stock-palette colour class, or a font family is a re-skin that would miss it.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const SRC = fileURLToPath(new URL(".", import.meta.url))
const LOOK_DIRS = new Set(["ui", "styles"])
const SCANNED = /\.(?:tsx?|css|html)$/
const TEST_FILE = /\.test\.tsx?$/

const COLOUR_FN = "(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\\("
const UTILITY =
	"(?:bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|outline|fill|stroke|from|via|to|decoration|divide|accent|caret|placeholder|shadow|inset-shadow|inset-ring|drop-shadow)"
const PALETTE =
	"(?:slate|gray|zinc|neutral|stone|mauve|olive|mist|taupe|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)"

const RULES: readonly { kind: string; re: RegExp }[] = [
	// Not after a word, `.`, `&` or `#`: skips `this.#field`, `&#123;` and `owner/repo#123`.
	{ kind: "colour literal", re: /(?<![\w.&#-])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi },
	{ kind: "colour function", re: new RegExp(`\\b${COLOUR_FN}`, "gi") },
	{
		kind: "arbitrary colour class",
		re: new RegExp(`(?<![\\w-])[a-z][\\w-]*?-(?:\\[(?:#|color:|var\\(--color-|${COLOUR_FN})|\\((?:color:|--color-))`, "gi"),
	},
	{ kind: "stock palette class", re: new RegExp(`(?<![\\w-])${UTILITY}-(?:${PALETTE}-\\d{2,3}|white|black)(?![\\w-])`, "g") },
	{
		kind: "font family",
		re: /font-family|fontFamily|@fontsource|(?<![\w-])font-[[(](?![\d.]+[\])]|weight:)|\b(?:Manrope|Archivo|DM Mono|Helvetica|Arial|Roboto|Segoe UI|Menlo|Consolas|system-ui|ui-sans-serif|ui-serif|ui-monospace|sans-serif)\b/g,
	},
]

function violations(text: string): string[] {
	return text
		.split("\n")
		.flatMap((line, i) => RULES.flatMap(({ kind, re }) => [...line.matchAll(re)].map((m) => `${i + 1}: ${kind} ${m[0]}`)))
}

function* scannedFiles(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) {
			if (dir !== SRC || !LOOK_DIRS.has(entry.name)) yield* scannedFiles(path)
		} else if (SCANNED.test(entry.name) && !TEST_FILE.test(entry.name)) {
			yield path
		}
	}
}

describe("look boundary", () => {
	it("recognises each forbidden kind", () => {
		const samples = [
			'color: "#1B1E2B"',
			"border: 1px solid #fff;",
			"background: rgba(0, 0, 0, .3)",
			"c = oklch(70% 0.1 200)",
			'className="bg-[var(--color-ink)] p-2"',
			'className="hover:text-(--color-ink-3)"',
			'className="text-slate-600"',
			'className="bg-white"',
			"font-family: serif",
			'className="font-[Inter]"',
			'const f = "DM Mono"',
		]
		for (const s of samples) expect(violations(s), s).not.toEqual([])
		const allowed = ['import { source } from "#data"', "this.#cafe = 1", 'className="font-[600] text-ink-3 bg-tone-ok-bg"', "&#123;"]
		for (const s of allowed) expect(violations(s), s).toEqual([])
	})

	it("holds for every source file outside src/ui and src/styles", () => {
		const found = [...scannedFiles(SRC)].flatMap((file) =>
			violations(readFileSync(file, "utf8")).map((v) => `${relative(SRC, file)}:${v}`),
		)
		expect(found).toEqual([])
	})
})
