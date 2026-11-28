import { MAX_LEAVES } from "@pp/label-paths"
import * as fc from "fast-check"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { propertyParams } from "../../../vitest.base"
import { fetchScopedRoot } from "./asp"

// The bounds the guard enforces, written out rather than read from the code.
const MAX_COMMAS = MAX_LEAVES + 16
const MAX_CONTAINERS = 16
const REFUSED = `association-set/root: more than ${MAX_LEAVES} entries, or more than ${MAX_CONTAINERS} containers`
const SCOPE = { chainId: 11_155_111, entrypoint: `0x${"11".repeat(20)}` } as const

let body = ""
beforeAll(() => {
	vi.stubGlobal("fetch", async () => new Response(body))
})
afterAll(() => {
	vi.unstubAllGlobals()
})

/** The guard's verdict on `text`, through the bot's own read of the ASP API's root. */
async function refuses(text: string): Promise<boolean> {
	body = text
	try {
		await fetchScopedRoot("http://asp.test", SCOPE)
		return false
	} catch (e) {
		const message = (e as Error).message
		expect(message, "valid JSON is never read as not JSON").not.toBe("association-set/root: the answer is not JSON")
		return message === REFUSED
	}
}

/** Containers and separating commas of a parsed JSON value: what `JSON.parse` allocated for it. */
function shape(v: unknown): { containers: number; commas: number } {
	if (v === null || typeof v !== "object") return { containers: 0, commas: 0 }
	const children = Array.isArray(v) ? v : Object.values(v)
	const out = { containers: 1, commas: Math.max(0, children.length - 1) }
	for (const c of children) {
		const s = shape(c)
		out.containers += s.containers
		out.commas += s.commas
	}
	return out
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

// Strings full of what a scanner can mistake for structure: quotes, backslashes, brackets and commas.
const text = fc.oneof(
	fc.string({ unit: fc.constantFrom('"', "\\", "[", "{", ",", "]", "}", "a", "/", "\n", " ", "é", "😀"), maxLength: 24 }),
	fc
		.tuple(fc.constantFrom("\\", '"', '\\"', "\\\\"), fc.constantFrom("[", "{", ","), fc.integer({ min: 1, max: 40 }))
		.map(([p, c, k]) => p + c.repeat(k)),
)
const scalar: fc.Arbitrary<Json> = fc.oneof(
	text,
	fc.integer(),
	fc.double({ noNaN: true, noDefaultInfinity: true }),
	fc.boolean(),
	fc.constant(null),
)

function put(into: Json[] | { [k: string]: Json }, key: string, v: Json): void {
	if (Array.isArray(into)) into.push(v)
	else {
		let k = key
		while (Object.hasOwn(into, k)) k += "_"
		Object.defineProperty(into, k, { value: v, enumerable: true, writable: true, configurable: true })
	}
}

/** A value with exactly `n` containers (0: a scalar), each nested under an earlier one, with scalars spread among them. */
const value: fc.Arbitrary<Json> = fc
	.integer({ min: 0, max: 22 })
	.chain((n) =>
		fc.record({
			n: fc.constant(n),
			parents: fc.array(fc.nat(), { minLength: n, maxLength: n }),
			objects: fc.array(fc.boolean(), { minLength: n, maxLength: n }),
			keys: fc.array(text, { minLength: n, maxLength: n }),
			leaves: fc.array(fc.tuple(fc.nat(), text, scalar), { maxLength: 10 }),
			root: scalar,
		}),
	)
	.map(({ n, parents, objects, keys, leaves, root }) => {
		if (n === 0) return root
		const made: (Json[] | { [k: string]: Json })[] = []
		for (let i = 0; i < n; i++) {
			const c = objects[i] ? {} : []
			if (i > 0) put(made[(parents[i] as number) % i] as Json[], keys[i] as string, c)
			made.push(c)
		}
		for (const [at, key, v] of leaves) put(made[at % n] as Json[], key, v)
		return made[0] as Json
	})

const SPACE = ["", " ", "\n", "\t", "\r\n  "]

/** JSON text for `v`, with whitespace and string escapes chosen by `pick`: any valid spelling, not only `JSON.stringify`'s. */
function encode(v: Json, pick: () => number): string {
	const ws = () => SPACE[pick() % SPACE.length] as string
	if (typeof v === "string") return quote(v, pick)
	if (v === null || typeof v !== "object") return JSON.stringify(v)
	const parts = Array.isArray(v)
		? v.map((x) => encode(x, pick))
		: Object.keys(v).map((k) => `${quote(k, pick)}${ws()}:${ws()}${encode(v[k] as Json, pick)}`)
	const [open, close] = Array.isArray(v) ? ["[", "]"] : ["{", "}"]
	return `${open}${ws()}${parts.join(`${ws()},${ws()}`)}${ws()}${close}`
}

const SHORT: Record<string, string> = { '"': '\\"', "\\": "\\\\", "\n": "\\n", "/": "\\/" }

/** Each UTF-16 unit as itself where JSON allows, as its short escape, or as `\uXXXX`. */
function quote(s: string, pick: () => number): string {
	let out = '"'
	for (let i = 0; i < s.length; i++) {
		const ch = s[i] as string
		const unicode = `\\u${s.charCodeAt(i).toString(16).padStart(4, "0")}`
		const raw = ch === '"' || ch === "\\" || s.charCodeAt(i) < 0x20 ? (SHORT[ch] ?? unicode) : ch
		out += [SHORT[ch] ?? raw, unicode, raw][pick() % 3]
	}
	return `${out}"`
}

const spelled = fc.tuple(value, fc.array(fc.nat(), { minLength: 1, maxLength: 64 })).map(([v, picks]) => {
	let i = 0
	return encode(v, () => picks[i++ % picks.length] as number)
})

describe("the ASP answer guard", () => {
	const nesting = "refuses a JSON text exactly when it parses into more than 16 containers or more separators than the leaves allow"
	const pn = propertyParams(import.meta.url, nesting, 1_000, 10_000)
	it(
		nesting,
		async () => {
			let refused = 0
			await fc.assert(
				fc.asyncProperty(spelled, async (t) => {
					const { containers, commas } = shape(JSON.parse(t))
					const want = containers > MAX_CONTAINERS || commas > MAX_COMMAS
					expect(await refuses(t), `containers ${containers}, commas ${commas}`).toBe(want)
					if (want) refused++
				}),
				pn.fc,
			)
			expect(refused, "texts on both sides of the bound").toBeGreaterThan(0)
		},
		pn.testTimeout,
	)

	// A text this size costs milliseconds to build and parse, so few runs; each tries both sides of the bound.
	const commas = "counts separators only outside strings, on both sides of the leaves' bound"
	const pc = propertyParams(import.meta.url, commas, 3, 20_000)
	it(
		commas,
		async () => {
			await fc.assert(
				fc.asyncProperty(text, fc.nat(), async (note, seed) => {
					let i = seed
					for (const leaves of [MAX_LEAVES + 15, MAX_LEAVES + 16, MAX_LEAVES + 17]) {
						const t = `{"note":${quote(note, () => i++)},"leaves":[${'"1",'.repeat(leaves - 1)}"1"]}`
						const s = shape(JSON.parse(t))
						expect(await refuses(t), `commas ${s.commas}`).toBe(s.commas > MAX_COMMAS)
					}
				}),
				pc.fc,
			)
		},
		pc.testTimeout,
	)
})
