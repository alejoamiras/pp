import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { propertyParams } from "../../../vitest.base"
import { PINNED_URLS } from "./network"
import { parseDeployment, serializeDeployment } from "./schema"

// ─── Each field's accepted forms, written from the file's contract rather than read from the schema ───

type Kind = "address" | "word" | "selector" | "decimal" | "port" | "positive" | "bps" | "chain" | "url"
const int = (v: unknown, lo: number, hi: number) => Number.isSafeInteger(v) && (v as number) >= lo && (v as number) <= hi
const ACCEPTS: Record<Kind, (v: unknown) => boolean> = {
	address: (v) => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && !/^0x0{40}$/.test(v),
	word: (v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v),
	selector: (v) => typeof v === "string" && /^0x[0-9a-fA-F]{8}$/.test(v),
	decimal: (v) => typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v),
	port: (v) => int(v, 1024, 65_535),
	positive: (v) => int(v, 1, Number.MAX_SAFE_INTEGER),
	bps: (v) => int(v, 0, 10_000),
	chain: (v) => v === 11_155_111 || v === 31_337,
	// Written with `://`, surrounding whitespace aside: the parser's repair of `https:/host` is not taken.
	url: (v) => typeof v === "string" && /^https?:\/\//i.test(v.trim()) && URL.canParse(v.trim()),
}
const KEYED: Record<string, Kind> = {
	l1ChainId: "chain",
	rollupVersion: "positive",
	forkBlock: "positive",
	botPort: "port",
	aspPort: "port",
	l1Rpc: "url",
	l1SendRpc: "url",
	aztecNode: "url",
	vettingFeeBps: "bps",
	selector: "selector",
}
const WORDS = new Set(["fpc", "l2Deployer", "botPoster", "birthIntake", "tokenClassId", "hub", "token", "registry", "factoryTx"])
const DECIMALS = new Set(["lifetimeCap", "debit", "note", "bridge", "shield", "minDeposit", "deployBlock"])

/** The kind of the leaf at `path`; undefined for the top-level fields and `aspApiUrl`, which have their own property. */
function kindOf(path: readonly string[]): Kind | undefined {
	const key = path.at(-1) as string
	if (path.length === 1 || key === "aspApiUrl") return undefined
	if (KEYED[key]) return KEYED[key]
	if (DECIMALS.has(key)) return "decimal"
	if (WORDS.has(key) || /codeHash$/i.test(key) || key === "forkBlockHash") return "word"
	return "address"
}

/** Pool contracts an operator block must name too, by the pool section's field and the block's path. */
const TIES: [string, string[]][] = [
	["poolVault", ["operator", "code", "vault", "proxy"]],
	["entrypoint", ["operator", "code", "entrypoint", "proxy"]],
	["keystore", ["operator", "code", "keystore", "proxy"]],
	["aspRegistry", ["operator", "code", "aspRegistry", "proxy"]],
	["asset", ["operator", "asset", "address"]],
]
const ZERO = `0x${"0".repeat(40)}`
const ASP_API = PINNED_URLS.aspApi[0]

// ─── Valid deployment files ───

type Json = Record<string, unknown>
const hex = (n: number) => fc.stringMatching(new RegExp(`^[0-9a-fA-F]{${n}}$`)).map((h) => `0x${h}`)
const address = hex(40).filter((a) => a !== ZERO)
const word = hex(64)
const decimal = fc.bigInt({ min: 0n, max: 2n ** 256n }).map(String)
const port = fc.integer({ min: 1024, max: 65_535 })
const positive = fc.integer({ min: 1, max: 2 ** 31 - 1 })
const url = fc.constantFrom(...PINNED_URLS.l1Rpc, ...PINNED_URLS.aztecNode, "http://127.0.0.1:8545", "http://localhost:8080/rpc")
const contract = fc.record({ proxy: address, proxyCodeHash: word, implementation: address, implementationCodeHash: word })
const verifier = fc.record({ verifier: address, codeHash: word })

/** A file with every optional field present, which `shape` trims to one target's form. */
const full = fc.record({
	description: fc.string({ maxLength: 40 }),
	network: fc.record({
		l1ChainId: fc.constantFrom(11_155_111, 31_337),
		rollup: address,
		l1Registry: address,
		inbox: address,
		outbox: address,
		rollupVersion: positive,
		fpc: word,
		l1Rpc: url,
		l1SendRpc: url,
		aztecNode: url,
		botPort: port,
		aspPort: port,
	}),
	expected: fc.record({
		guardian: address,
		lifetimeCap: decimal,
		l1Deployer: address,
		l2Deployer: word,
		botPoster: word,
		aspPostman: address,
		poolDeployer: address,
		canaryOwner: address,
		canarySender: address,
		demoOwner: address,
		demoSender: address,
		birthIntake: word,
		tokenClassId: word,
		amounts: fc.record({ debit: decimal, note: decimal, bridge: decimal, shield: decimal }),
	}),
	operator: fc.record({
		code: fc.record({ vault: contract, entrypoint: contract, keystore: contract, aspRegistry: contract }),
		depositVerifier: verifier,
		ragequitVerifier: verifier,
		transactRoute1x1: fc.record({ verifier: address, selector: hex(8), codeHash: word }),
		asset: fc.record({ address, vettingFeeBps: fc.integer({ min: 0, max: 10_000 }), minDeposit: decimal }),
		evidence: fc.record({ forkBlock: positive, forkBlockHash: word }),
	}),
	pool: fc.record({
		poolVault: address,
		entrypoint: address,
		aspRegistry: address,
		keystore: address,
		asset: address,
		deployBlock: decimal,
		aspApiUrl: fc.constant(""),
		accessRouter: address,
		relay: address,
	}),
	bridge: fc.record({ factory: address, portal: address, hub: word, token: word, registry: word, deployBlock: decimal, factoryTx: word }),
})

const recase = (a: string, upper: boolean) => `0x${upper ? a.slice(2).toUpperCase() : a.slice(2).toLowerCase()}`

/** The optional parts `shape` may drop, each kept or dropped by its own drawn bit. */
const PARTS = [
	"description",
	"l1SendRpc",
	"demoOwner",
	"demoSender",
	"shield",
	"ceremony",
	"pinnedAsp",
	"aspPostman",
	"poolDeployer",
	"accessRouter",
	"relay",
	"operator",
	"expected",
	"pool",
	"bridge",
] as const
type Part = (typeof PARTS)[number]

/** Trims `f` to a valid file of `target`, dropping each part `keep` does not hold. */
function shape(f: Json, target: "own" | "pool1", keep: ReadonlySet<Part>, loopbackAsp: string, upper: boolean): Json {
	const d = structuredClone(f) as Record<string, Json>
	const [network, expected, pool] = [d.network, d.expected, d.pool] as Json[]
	const drop = (part: Part, parent: Json, key: string = part) => {
		if (!keep.has(part)) delete parent[key]
	}
	d.target = target as never
	drop("description", d)
	drop("l1SendRpc", network)
	drop("demoOwner", expected)
	drop("demoSender", expected)
	drop("shield", expected.amounts as Json)
	if (target === "own") {
		d.bundle = "ceremony" as never
		delete d.operator
		pool.aspApiUrl = `http://127.0.0.1:${network.aspPort}`
	} else {
		d.bundle = (keep.has("ceremony") ? "ceremony" : "pre-ceremony") as never
		delete network.aspPort
		pool.aspApiUrl = keep.has("pinnedAsp") ? ASP_API : loopbackAsp
		drop("aspPostman", expected)
		drop("poolDeployer", expected)
		drop("accessRouter", pool)
		drop("relay", pool)
		for (const [field, path] of TIES) setIn(d, path, recase(pool[field] as string, upper))
		drop("operator", d)
	}
	drop("expected", d)
	drop("pool", d)
	drop("bridge", d)
	return d
}

/** Valid files of `targets` that always keep the parts in `always`. */
const deploymentOf = (targets: readonly ("own" | "pool1")[], always: readonly Part[] = []) =>
	fc
		.tuple(
			full,
			fc.constantFrom(...targets),
			fc.subarray([...PARTS]),
			fc.tuple(port, fc.constantFrom("127.0.0.1", "localhost", "[::1]")).map(([p, h]) => `http://${h}:${p}`),
			fc.boolean(),
		)
		.map(([f, target, kept, asp, upper]) => shape(f, target, new Set([...kept, ...always]), asp, upper))
const deployment = deploymentOf(["own", "pool1"])

// ─── Walking and editing a file ───

type Leaf = { path: string[]; value: unknown }
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v)
function leavesOf(v: Json, path: string[] = []): Leaf[] {
	return Object.entries(v).flatMap(([k, c]) => (isObject(c) ? leavesOf(c, [...path, k]) : [{ path: [...path, k], value: c }]))
}
function objectsOf(v: Json, path: string[] = []): string[][] {
	return [path, ...Object.entries(v).flatMap(([k, c]) => (isObject(c) ? objectsOf(c, [...path, k]) : []))]
}
function setIn(v: Json, path: readonly string[], value: unknown): void {
	const parent = path.slice(0, -1).reduce((o, k) => o[k] as Json, v)
	parent[path.at(-1) as string] = value
}
const withValue = (v: Json, path: readonly string[], value: unknown): Json => {
	const copy = structuredClone(v)
	setIn(copy, path, value)
	return copy
}
function attempt(file: Json): { ok: true } | { ok: false; message: string } {
	try {
		parseDeployment(file)
		return { ok: true }
	} catch (e) {
		return { ok: false, message: (e as Error).message }
	}
}
/** Whether `path` must agree with another field, so its own form alone does not decide the file. */
const tied = (d: Json, path: readonly string[]) =>
	path.join(".") === "network.aspPort" ||
	(d.operator !== undefined &&
		d.pool !== undefined &&
		TIES.some(([field, op]) => path.join(".") === `pool.${field}` || path.join(".") === op.join(".")))

// ─── Near misses of a valid value ───

const NOISE = ["0", "a", "F", "g", "x", "X", " ", "\n", "-", ".", "٣"]
const edit = fc.record({
	op: fc.constantFrom("delete", "insert", "replace", "upper-prefix", "pad", "zero", "lead-zero", "negate", "number", "other"),
	at: fc.nat(),
	ch: fc.constantFrom(...NOISE),
	step: fc.integer({ min: -3, max: 3 }),
	other: fc.constantFrom<unknown>(null, true, [], {}, "", 1.5, "1e3", Number.MAX_SAFE_INTEGER + 1),
})
type Edit = typeof edit extends fc.Arbitrary<infer T> ? T : never

/** One edit of `value`, a string or a number: what a hand edit or a bad merge leaves in a field. */
function applyEdit(value: unknown, e: Edit): unknown {
	if (e.op === "other") return e.other
	if (typeof value === "number") {
		if (e.op === "number") return String(value)
		if (e.op === "negate") return -value
		if (e.op === "pad") return value + 0.5
		return value + e.step
	}
	const s = value as string
	const i = e.at % (s.length + 1)
	switch (e.op) {
		case "delete":
			return s.slice(0, i) + s.slice(i + 1)
		case "insert":
			return s.slice(0, i) + e.ch + s.slice(i)
		case "replace":
			return s.slice(0, i) + e.ch + s.slice(i + 1)
		case "upper-prefix":
			return s.replace(/^0x/, "0X")
		case "pad":
			return ` ${s}${e.ch}`
		case "zero":
			return s.startsWith("0x") ? `0x${"0".repeat(s.length - 2)}` : "0"
		case "lead-zero":
			return `0${s}`
		case "negate":
			return `-${s}`
		default:
			return Number(s)
	}
}

// ─── Properties ───

describe("the testnet deployment file", () => {
	const roundTrip = "serializes every valid file back to the JSON it was parsed from"
	const pr = propertyParams(import.meta.url, roundTrip, 100, 10_000)
	it(
		roundTrip,
		() => {
			fc.assert(
				fc.property(deployment, (raw) => {
					const text = serializeDeployment(parseDeployment(raw))
					expect(JSON.parse(text)).toEqual(raw)
					expect(serializeDeployment(parseDeployment(JSON.parse(text)))).toBe(text)
				}),
				pr.fc,
			)
		},
		pr.testTimeout,
	)

	const forms = "accepts a field's new value exactly when it has the field's form, and names the field it refuses"
	const pf = propertyParams(import.meta.url, forms, 300, 10_000)
	// Every section present, and the kind drawn before the field, so the rare kinds are edited as often as addresses.
	const sectioned = fc.oneof(
		deploymentOf(["own"], ["expected", "pool", "bridge"]),
		deploymentOf(["pool1"], ["expected", "operator", "pool", "bridge"]),
	)
	const kinds = Object.keys(ACCEPTS) as Kind[]
	it(
		forms,
		() => {
			const refused = new Set<Kind>()
			let accepted = 0
			fc.assert(
				fc.property(sectioned, fc.nat(), fc.nat(), edit, (raw, which, pick, e) => {
					const free = leavesOf(raw).filter((l) => kindOf(l.path) !== undefined && !tied(raw, l.path))
					const present = kinds.filter((k) => free.some((l) => kindOf(l.path) === k))
					const want = present[which % present.length] as Kind
					const leaves = free.filter((l) => kindOf(l.path) === want)
					const { path, value } = leaves[pick % leaves.length] as Leaf
					const next = applyEdit(value, e)
					const r = attempt(withValue(raw, path, next))
					expect(r.ok, `${path.join(".")} = ${JSON.stringify(next)}`).toBe(ACCEPTS[want](next))
					if (r.ok) accepted++
					else {
						expect(r.message).toContain(`${path.join(".")}: `)
						refused.add(want)
					}
				}),
				pf.fc,
			)
			expect([...refused].sort(), "a refused edit of every kind").toEqual([...kinds].sort())
			expect(accepted, "edits on both sides of the forms").toBeGreaterThan(0)
		},
		pf.testTimeout,
	)

	const zero = "refuses the zero address in every address field"
	const pz = propertyParams(import.meta.url, zero, 30, 10_000)
	it(
		zero,
		() => {
			fc.assert(
				fc.property(deployment, (raw) => {
					for (const { path } of leavesOf(raw).filter((l) => kindOf(l.path) === "address")) {
						const r = attempt(withValue(raw, path, ZERO))
						expect(r.ok ? "accepted" : r.message, path.join(".")).toContain(
							`${path.join(".")}: the zero address names no account or contract`,
						)
					}
				}),
				pz.fc,
			)
		},
		pz.testTimeout,
	)

	const strict = "refuses a key the file does not define, in every object, naming that object"
	const ps = propertyParams(import.meta.url, strict, 200, 10_000)
	it(
		strict,
		() => {
			fc.assert(
				fc.property(deployment, fc.nat(), fc.stringMatching(/^[a-z][a-zA-Z]{0,11}$/), (raw, pick, name) => {
					const objects = objectsOf(raw)
					const path = objects[pick % objects.length] as string[]
					const parent = path.reduce((o, k) => o[k] as Json, raw)
					const key = name in parent || name in Object.prototype ? `x${name}` : name
					const r = attempt(withValue(raw, [...path, key], "0x01"))
					expect(r.ok ? "accepted" : r.message).toContain(`${path.join(".") || "(root)"}: Unrecognized key: "${key}"`)
				}),
				ps.fc,
			)
		},
		ps.testTimeout,
	)

	const asp = "reaches a pool's ASP only at its pinned API, or at loopback over http, never a URL near either"
	const pa = propertyParams(import.meta.url, asp, 300, 10_000)
	const nearAsp = fc.oneof(
		fc.constantFrom(
			ASP_API,
			`${ASP_API}/`,
			`${ASP_API}/v1`,
			`${ASP_API}?x=1`,
			`${ASP_API}#a`,
			`${ASP_API}:443`,
			ASP_API.replace("https:", "http:"),
			ASP_API.toUpperCase(),
			ASP_API.replace("//", "//x@"),
			`${ASP_API}.evil.test`,
			` ${ASP_API}`,
			"http://127.0.0.1.evil.test",
			"http://localhost@evil.test",
			"https://127.0.0.1:4000",
			"http://127.0.0.2:4000",
			"http://0.0.0.0:4000",
			"http://[::1]:4000",
			"http://localhost:4000/api",
		),
		fc.tuple(fc.constantFrom(...ASP_API), fc.nat()).map(([c, i]) => {
			const at = i % ASP_API.length
			return ASP_API.slice(0, at) + c + ASP_API.slice(at)
		}),
	)
	it(
		asp,
		() => {
			fc.assert(
				fc.property(deploymentOf(["own", "pool1"], ["pool"]), nearAsp, (raw, u) => {
					const r = attempt(withValue(raw, ["pool", "aspApiUrl"], u))
					const network = raw.network as Json
					const loop =
						URL.canParse(u) &&
						new URL(u).protocol === "http:" &&
						["127.0.0.1", "localhost", "[::1]"].includes(new URL(u).hostname)
					const want = raw.target === "own" ? u === `http://127.0.0.1:${network.aspPort}` : u === ASP_API || loop
					expect(r.ok ? "accepted" : r.message, u).toEqual(want ? "accepted" : expect.stringContaining("pool.aspApiUrl: "))
				}),
				pa.fc,
			)
		},
		pa.testTimeout,
	)

	const ties = "takes an operator block naming the pool's contracts in any letter case, and refuses one naming another"
	const pt = propertyParams(import.meta.url, ties, 200, 10_000)
	it(
		ties,
		() => {
			fc.assert(
				fc.property(deploymentOf(["pool1"], ["operator", "pool"]), fc.nat(), address, fc.boolean(), (raw, pick, other, upper) => {
					const [field, op] = TIES[pick % TIES.length] as [string, string[]]
					const pool = raw.pool as Json
					expect(attempt(withValue(raw, op, recase(pool[field] as string, upper))).ok).toBe(true)
					if (other.toLowerCase() === (pool[field] as string).toLowerCase()) return
					const moved = attempt(withValue(raw, op, other))
					expect(moved.ok ? "accepted" : moved.message).toContain(
						`${op.join(".")}: ${other}, the pool section names ${pool[field]}`,
					)
				}),
				pt.fc,
			)
		},
		pt.testTimeout,
	)
})
