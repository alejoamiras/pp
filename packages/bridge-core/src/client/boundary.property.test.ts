import { inspect } from "node:util"
import { SpecRangeError } from "@pp/bridge-spec"
import { PoolClientError, type PoolClientErrorCode } from "@pp/pool-client"
import * as fc from "fast-check"
import { BaseError, ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult, type Hash, type Hex } from "viem"
import { describe, expect, it } from "vitest"
import { propertyParams } from "../../../../vitest.base"
import { PROCESSOR_PORTAL_ABI } from "../factory-abi"
import { translate } from "./boundary"
import {
	BridgeClientError,
	type BridgeClientErrorCode,
	type BridgeClientErrorDetail,
	type SpendCheckName,
	type StaleRootCode,
} from "./errors"

// `satisfies Record<…>` fails to compile when a union gains or loses a member, so these lists cannot drift.
const keys = <K extends string>(o: Record<K, 0>) => Object.keys(o) as K[]
const CODES = keys({
	FORGED_SESSION: 0,
	SESSION_DEPLOYMENT_MISMATCH: 0,
	DEPLOYMENT_MISMATCH: 0,
	CHAIN_MISMATCH: 0,
	RECIPIENT_INVALID: 0,
	RECIPIENT_NOT_IN_WALLET: 0,
	FEE_PATH_FAILED: 0,
	PREFLIGHT_REQUIRED: 0,
	SPEND_MISMATCH: 0,
	SENDER_IS_OWNER: 0,
	IN_FLIGHT: 0,
	UNCERTAIN: 0,
	STALE: 0,
	SIMULATION_REVERTED: 0,
	REVERTED: 0,
	CONSUMED_ELSEWHERE: 0,
	NOTE_NOT_FOUND: 0,
	OPENING_MISMATCH: 0,
	NOT_CLAIMABLE: 0,
	EXIT_NOT_READY: 0,
	STAGE_UNSUPPORTED: 0,
	TICKET_NOT_FOUND: 0,
	NO_EXACT_CHUNKS: 0,
	RPC_FAILED: 0,
	RPC_INCONSISTENT: 0,
} satisfies Record<BridgeClientErrorCode, 0>)
const CHECKS = keys({
	shape: 0,
	request: 0,
	params: 0,
	public: 0,
	nullifier: 0,
	change: 0,
	context: 0,
	salt: 0,
	secretHash: 0,
	data: 0,
	processor: 0,
	asset: 0,
	recipient: 0,
} satisfies Record<SpendCheckName, 0>)
const STALE = keys({ STATE_ROOT_STALE: 0, KEYSTORE_ROOT_STALE: 0, ASP_ROOT_STALE: 0 } satisfies Record<StaleRootCode, 0>)
const POOL_CODES = keys({
	SIGNATURE_INVALID: 0,
	CHAIN_MISMATCH: 0,
	STATE_ROOT_STALE: 0,
	KEYSTORE_ROOT_STALE: 0,
	ASP_ROOT_STALE: 0,
	NOTE_NOT_FOUND: 0,
	NOTE_NOT_APPROVED: 0,
	AMOUNT_OUT_OF_RANGE: 0,
	ASSET_MISMATCH: 0,
	ARTIFACT_MISMATCH: 0,
	SPEND_CHECK_FAILED: 0,
	NULLIFIER_NOT_FOUND: 0,
	KEYSTORE_MISMATCH: 0,
	REGISTERED_TO_OTHER_KEYS: 0,
} satisfies Record<PoolClientErrorCode, 0>)

// The test's own statement of the field rules, so a loosened pattern in errors.ts fails here.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const HASH = /^0x[0-9a-fA-F]{64}$/
const FIELDS = ["check", "stale", "revert", "source", "l1TxHash"] as const
type Fields = Partial<Record<(typeof FIELDS)[number], unknown>>

/**
 * A secret a lower layer may hold. `ident` is identifier-shaped on purpose: a value that only ever fails the
 * identifier pattern could not reveal a translation that copies it into `source`. Its leading hex digit is
 * nonzero, so even a shrunk `dec` has at least 23 digits, more than any line number in a stack.
 */
type Marker = { ident: string; hex: string; dec: string; value: bigint }
const marker = fc
	.stringMatching(/^[1-9a-f][0-9a-f]{19}$/)
	.map((hex): Marker => ({ ident: `Zq9${hex}`, hex, dec: BigInt(`0x${hex}`).toString(), value: BigInt(`0x${hex}`) }))
const leaksOf = (m: Marker) => [m.ident, m.hex, m.dec]

// Names are allowed through when identifier-shaped and not a hex run, so they never carry the marker. The
// longest valid one pins the 64-character limit from below; the forged 65-character one pins it from above.
const longest = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{63}$/)
const name = fc
	.oneof(fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,20}$/), longest)
	.filter((n) => !n.startsWith("Zq9") && !/^[0-9a-f]{16,}$/i.test(n))
const OVERLONG = `A${"b".repeat(64)}`
const hash = fc.stringMatching(/^[0-9a-f]{64}$/).map((h) => `0x${h}` as Hash)
const validDetail = fc.record(
	{
		check: fc.constantFrom(...CHECKS),
		stale: fc.option(fc.constantFrom(...STALE), { nil: null }),
		revert: name,
		source: name,
		l1TxHash: hash,
	},
	{ requiredKeys: [] },
)

/** Built inside the property: fast-check inspects every generated value, and a hostile proxy must not fire there. */
type Thrown = { kind: string; make: () => unknown; keeps?: { code: BridgeClientErrorCode; detail: BridgeClientErrorDetail } }
const thrown = (kind: string, make: () => unknown): Thrown => ({ kind, make })

const lowerError = (m: Marker): fc.Arbitrary<Thrown> =>
	fc.oneof(
		fc.constant(thrown("error", () => new Error(`rpc failed for ${m.ident} at ${m.dec}`))),
		fc.constant(thrown("string", () => m.ident)),
		fc.constant(thrown("decimal", () => `${m.dec} ${m.hex}`)),
		fc.constant(thrown("symbol", () => Symbol(m.ident))),
		fc.constant(thrown("type error", () => new TypeError(m.ident))),
		fc.anything().map((v) => thrown("anything", () => v)),
	)

type How = { cyclic: boolean; hiddenKey: string; label: string | undefined }

function decorated(base: Error, m: Marker, how: How): Error {
	Object.assign(base, { opening: m.value, salt: m.ident, args: [m.value], data: `0x${m.hex}` })
	Object.defineProperty(base, how.hiddenKey, { value: m.ident, enumerable: false })
	Object.defineProperty(base, "secretGetter", { get: () => m.ident, enumerable: false })
	Object.defineProperty(base, "cause", { value: how.cyclic ? base : new Error(m.ident), enumerable: true })
	if (how.label !== undefined) Object.defineProperty(base, "name", { value: how.label })
	return base
}

function trapped(m: Marker, prop: string): Error {
	const e = new Error(m.ident)
	Object.defineProperty(e, prop, {
		get() {
			throw new Error(m.ident)
		},
	})
	return e
}

function proxied(m: Marker, mode: "throw" | "answer"): unknown {
	const target = new Error("x")
	if (mode === "throw") {
		const no = () => {
			throw new Error(m.ident)
		}
		return new Proxy(target, { get: no, getPrototypeOf: no, has: no, ownKeys: no, getOwnPropertyDescriptor: no })
	}
	const secret = new Set(["message", "cause", "stack", "details", "shortMessage", "args", "data", "metaMessages"])
	return new Proxy(target, { get: (t, p, r) => (typeof p === "string" && secret.has(p) ? m.ident : Reflect.get(t, p, r)) })
}

const Anonymous = (() => class extends Error {})()

const viemErrors = (m: Marker): fc.Arbitrary<Thrown> =>
	fc.constantFrom(
		thrown(
			"execution error",
			() =>
				new ContractFunctionExecutionError(new BaseError(`reverted with ${m.ident}`), {
					abi: PROCESSOR_PORTAL_ABI,
					functionName: "bridgeFromPool",
					args: [m.value, m.value],
				}),
		),
		thrown(
			"revert",
			() =>
				new ContractFunctionRevertedError({
					abi: PROCESSOR_PORTAL_ABI,
					functionName: "bridgeFromPool",
					data: `0xdeadbeef${m.hex}` as Hex,
				}),
		),
		{
			// A known error decodes, and its message then prints the arguments.
			kind: "decoded revert",
			make: () =>
				new ContractFunctionRevertedError({
					abi: PROCESSOR_PORTAL_ABI,
					functionName: "bridgeFromPool",
					data: encodeErrorResult({ abi: PROCESSOR_PORTAL_ABI, errorName: "CapExceeded", args: [m.value, m.value] }),
				}),
			keeps: { code: "SIMULATION_REVERTED", detail: { revert: "CapExceeded" } },
		},
	)

const lowerTyped = (m: Marker): fc.Arbitrary<Thrown> =>
	fc.oneof(
		fc
			.tuple(
				fc.constantFrom(...POOL_CODES),
				fc.option(fc.oneof(fc.constantFrom(...CHECKS), fc.constant(m.ident)), { nil: undefined }),
			)
			.map(([code, check]) =>
				thrown(
					`pool ${code}`,
					() => new PoolClientError(code, `salt ${m.dec} ${m.ident}`, check === undefined ? {} : ({ check } as never)),
				),
			),
		fc
			.oneof(name, fc.constant(`${m.ident}-code`))
			.map((code) => thrown("spec", () => new SpecRangeError(code as never, "secretHash", m.ident))),
		viemErrors(m),
	)

const hostile = (m: Marker): fc.Arbitrary<Thrown> => {
	const label = fc.option(fc.oneof(name, fc.constant(`${m.ident}-label`)), { nil: undefined })
	const how = fc.record({ cyclic: fc.boolean(), hiddenKey: fc.constantFrom("secret", "opening2", "raw"), label })
	const plain = fc.oneof(
		lowerError(m),
		how.map((h) => thrown("decorated error", () => decorated(new Error(`opening ${m.dec}`), m, h))),
		fc
			.tuple(how, name)
			.map(([h, n]) => thrown("anonymous class", () => decorated(Object.assign(new Anonymous(m.ident), { name: n }), m, h))),
		// A lower layer's class name is kept as the source, up to the 64-character limit.
		name.map(
			(n): Thrown => ({
				kind: "named class",
				make: () => new ({ [n]: class extends Error {} })[n](m.ident),
				keeps: { code: "RPC_FAILED", detail: { source: n } },
			}),
		),
		fc
			.constantFrom("name", "message", "constructor", "code", "cause", "stack")
			.map((p) => thrown(`throwing ${p}`, () => trapped(m, p))),
		fc.constantFrom("throw" as const, "answer" as const).map((mode) => thrown(`proxy ${mode}`, () => proxied(m, mode))),
		lowerTyped(m),
		// The client's own type, forged: an unknown code or a detail value outside its field's rule.
		fc
			.constantFrom(
				{ code: "NOPE" },
				{ l1TxHash: m.ident },
				{ source: `${m.ident}-x` },
				{ check: m.ident },
				{ source: OVERLONG },
				{ revert: OVERLONG },
			)
			.map((forged) => thrown("forged", () => Object.assign(new BridgeClientError("UNCERTAIN"), forged))),
	)
	// The client's own type, valid and decorated: it must come back with the same code and fields.
	const own = fc.tuple(fc.constantFrom(...CODES), validDetail, how).map(
		([code, detail, h]): Thrown => ({
			kind: "own",
			make: () => {
				const e = decorated(new BridgeClientError(code, detail), m, { ...h, label: undefined })
				Object.defineProperty(e, "message", { value: `${code} ${m.ident}` })
				return e
			},
			keeps: { code, detail },
		}),
	)
	return fc.oneof(plain, own)
}

const composed = (code: string, f: Fields) => {
	const parts = FIELDS.filter((k) => f[k] !== undefined).map((k) => `${k}=${String(f[k])}`)
	return parts.length === 0 ? code : `${code} (${parts.join(", ")})`
}

function expectFieldRules(r: BridgeClientError): void {
	expect(CODES).toContain(r.code)
	if (r.check !== undefined) expect(CHECKS).toContain(r.check)
	if (r.stale !== undefined && r.stale !== null) expect(STALE).toContain(r.stale)
	for (const k of ["revert", "source"] as const) if (r[k] !== undefined) expect(r[k]).toMatch(IDENTIFIER)
	if (r.l1TxHash !== undefined) expect(r.l1TxHash).toMatch(HASH)
	expect(r.message).toBe(composed(r.code, r))
	expect("cause" in r).toBe(false)
}

// Own properties a translated error may carry (the runtime adds its own to every error); a copied accessor
// would hide from every printed view.
const OWN = new Set([...Object.getOwnPropertyNames(new BridgeClientError("RPC_FAILED")), ...FIELDS])

function expectNoLeak(r: BridgeClientError, m: Marker): void {
	expect(Object.getOwnPropertyNames(r).filter((k) => !OWN.has(k))).toEqual([])
	expect(Object.getOwnPropertySymbols(r)).toEqual([])
	const views = [String(r), JSON.stringify(r), inspect(r, { depth: 10, showHidden: true }), r.stack ?? ""].map((v) => v.toLowerCase())
	for (const view of views) for (const leak of leaksOf(m)) expect(view).not.toContain(leak.toLowerCase())
}

describe("error boundary properties (whatever a lower layer throws)", () => {
	const any = propertyParams(import.meta.url, "translate returns a clean BridgeClientError for any thrown value", 300, 4_000)
	it(
		"translate returns a clean BridgeClientError for any thrown value",
		() => {
			fc.assert(
				fc.property(
					marker.chain((m) => hostile(m).map((t) => ({ m, t }))),
					({ m, t }) => {
						const r = translate(t.make())
						expect(r).toBeInstanceOf(BridgeClientError)
						expectFieldRules(r)
						expectNoLeak(r, m)
						if (t.keeps) {
							const fields = Object.fromEntries(FIELDS.flatMap((k) => (r[k] === undefined ? [] : [[k, r[k]]])))
							expect({ code: r.code, ...fields }).toEqual({ code: t.keeps.code, ...t.keeps.detail })
						} else {
							expect(r.l1TxHash).toBeUndefined()
						}
					},
				),
				any.fc,
			)
		},
		any.testTimeout,
	)

	it("keeps a name of 15 hex digits as the source and refuses one of 16, from the name field or the class", () => {
		const [short, long] = ["abcdef012345678", "abcdef0123456789"]
		const viaName = (n: string) => translate(Object.assign(new Error("x"), { name: n })).source
		const viaClass = (n: string) => translate(new { [n]: class extends Error {} }[n]("x")).source
		expect([viaName(short), viaName(long), viaClass(short), viaClass(long)]).toEqual([short, undefined, short, undefined])
	})
})
