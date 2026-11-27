import { aspLeaf, assertLeanImtMember, BN254_P, buildLeanImt } from "@pp/bridge-spec"
import * as fc from "fast-check"
import { describe, expect, it } from "vitest"
import { propertyParams } from "../../../vitest.base"
import { parseAspSnapshot, serializeAspSnapshot } from "./codec"
import { type AspSnapshot, pathFor, SnapshotError } from "./snapshot"

type Wire = Record<string, unknown>

const field = fc.bigInt({ min: 1n, max: BN254_P - 1n })
// Small labels repeat, so pool trees with duplicate leaves are common.
const label = fc.oneof(field, fc.bigInt({ min: 1n, max: 3n }))

const snapshotOf = (poolLabels: bigint[], birthLabels: bigint[], sequence: bigint): AspSnapshot => {
	const poolLeaves = poolLabels.map(aspLeaf)
	const birthLeaves = [...new Set(birthLabels.map(aspLeaf))].sort((a, b) => (a < b ? -1 : 1))
	return {
		sequence,
		poolRoot: buildLeanImt(poolLeaves).root,
		birthRoot: buildLeanImt(birthLeaves).root,
		poolLeaves,
		birthLeaves,
	}
}

const valid = fc
	.record({
		pool: fc.array(label, { maxLength: 12 }),
		birth: fc.uniqueArray(field, { maxLength: 8 }),
		sequence: fc.bigInt({ min: 1n, max: 2n ** 64n - 1n }),
	})
	.map(({ pool, birth, sequence }) => ({ snap: snapshotOf(pool, birth, sequence), pool, birth }))

const wireOf = (s: AspSnapshot): Wire => JSON.parse(serializeAspSnapshot(s)) as Wire

/** Throws anything but a `SnapshotError` out; returns whether the input was accepted. */
const accepted = (json: unknown): boolean => {
	try {
		parseAspSnapshot(json)
		return true
	} catch (e) {
		if (e instanceof SnapshotError) return false
		throw e
	}
}

const badDecimal = fc.oneof(
	fc.nat().map((n) => `0${n}`),
	fc.nat().map((n) => `-${n + 1}`),
	fc.nat().map((n) => `+${n}`),
	fc.nat().map((n) => ` ${n}`),
	fc.nat().map((n) => `${n}e1`),
	fc.constant("9".repeat(79)),
	fc.constant(""),
)
const hostile = fc.oneof(fc.jsonValue(), badDecimal, fc.array(fc.oneof(badDecimal, fc.jsonValue()), { maxLength: 4 }))
const KEYS = ["birthLeaves", "birthRoot", "poolLeaves", "poolRoot", "sequence"] as const

const mutation = fc.oneof(
	fc.record({ kind: fc.constant("drop" as const), key: fc.constantFrom(...KEYS) }),
	fc.record({ kind: fc.constant("extra" as const) }),
	fc.record({ kind: fc.constant("hostile" as const), key: fc.constantFrom(...KEYS), value: hostile }),
	fc.record({ kind: fc.constant("root" as const), key: fc.constantFrom("poolRoot" as const, "birthRoot" as const), to: field }),
	fc.record({ kind: fc.constant("leaf" as const), at: fc.nat(), to: field }),
	fc.record({ kind: fc.constant("swapPool" as const), at: fc.nat() }),
	fc.record({ kind: fc.constant("unsortBirth" as const), at: fc.nat() }),
	fc.record({ kind: fc.constant("sequence" as const), to: fc.bigInt({ min: 0n, max: 2n ** 65n }) }),
)

type Mutation = typeof mutation extends fc.Arbitrary<infer T> ? T : never
type Of<K extends Mutation["kind"]> = Extract<Mutation, { kind: K }>

// The roots do not bind the sequence, so any decimal in [1, 2^64) there must still parse.
const validSequence = (v: unknown) => typeof v === "string" && /^[1-9][0-9]{0,19}$/.test(v) && BigInt(v) < 2n ** 64n

// Each applier edits `json` in place and returns whether the result must parse, or null for a no-op change.
const set = (json: Wire, key: string, value: unknown): false | null => {
	if (JSON.stringify(json[key]) === JSON.stringify(value)) return null
	json[key] = value
	return false
}

const swap = (list: string[], at: number): false | null => {
	if (list.length < 2) return null
	const i = at % (list.length - 1)
	if (list[i] === list[i + 1]) return null
	;[list[i], list[i + 1]] = [list[i + 1] as string, list[i] as string]
	return false
}

const APPLY: { [K in Mutation["kind"]]: (json: Wire, m: Of<K>) => boolean | null } = {
	drop: (json, m) => {
		delete json[m.key]
		return false
	},
	extra: (json) => set(json, "extra", "1"),
	hostile: (json, m) => (set(json, m.key, m.value) === null ? null : m.key === "sequence" && validSequence(m.value)),
	root: (json, m) => set(json, m.key, m.to.toString()),
	leaf: (json, m) => {
		const pool = json.poolLeaves as string[]
		if (pool.length === 0) return null
		const at = m.at % pool.length
		if (pool[at] === m.to.toString()) return null
		pool[at] = m.to.toString()
		return false
	},
	swapPool: (json, m) => swap(json.poolLeaves as string[], m.at),
	unsortBirth: (json, m) => swap(json.birthLeaves as string[], m.at),
	sequence: (json, m) => (set(json, "sequence", m.to.toString()) === null ? null : validSequence(m.to.toString())),
}

function mutate(w: Wire, m: Mutation): { json: Wire; ok: boolean } | null {
	const json: Wire = structuredClone(w)
	const ok = (APPLY[m.kind] as (json: Wire, m: Mutation) => boolean | null)(json, m)
	return ok === null ? null : { json, ok }
}

describe("ASP snapshot codec properties (clients parse a server's bytes)", () => {
	const anyJson = propertyParams(import.meta.url, "arbitrary JSON parses or throws SnapshotError, nothing else", 300, 3_000)
	it(
		"arbitrary JSON parses or throws SnapshotError, nothing else",
		() => {
			const nearValid = fc.record(Object.fromEntries(KEYS.map((k) => [k, hostile])) as Record<(typeof KEYS)[number], typeof hostile>)
			fc.assert(
				fc.property(fc.oneof(fc.jsonValue(), nearValid), (json) => {
					accepted(json)
				}),
				anyJson.fc,
			)
		},
		anyJson.testTimeout,
	)

	const roundTrip = propertyParams(import.meta.url, "a valid snapshot survives serialize then parse", 60, 3_000)
	it(
		"a valid snapshot survives serialize then parse",
		() => {
			fc.assert(
				fc.property(valid, ({ snap }) => {
					expect(parseAspSnapshot(wireOf(snap))).toEqual(snap)
				}),
				roundTrip.fc,
			)
		},
		roundTrip.testTimeout,
	)

	const mutations = propertyParams(import.meta.url, "every one-field mutation is refused, except a new valid sequence", 200, 4_000)
	it(
		"every one-field mutation is refused, except a new valid sequence",
		() => {
			fc.assert(
				fc.property(valid, mutation, ({ snap }, m) => {
					const changed = mutate(wireOf(snap), m)
					fc.pre(changed !== null)
					expect(accepted(changed!.json)).toBe(changed!.ok)
				}),
				mutations.fc,
			)
		},
		mutations.testTimeout,
	)

	const paths = propertyParams(import.meta.url, "pathFor finds a label in its origin's tree only, at its first offset", 60, 3_000)
	it(
		"pathFor finds a label in its origin's tree only, at its first offset",
		() => {
			const input = valid.chain((v) =>
				fc.record({
					v: fc.constant(v),
					probe: fc.oneof(fc.constantFrom(...v.pool, ...v.birth, 1n), field),
					origin: fc.constantFrom(0 as const, 1 as const),
				}),
			)
			fc.assert(
				fc.property(input, ({ v: { snap }, probe, origin }) => {
					const leaves = origin === 0 ? snap.poolLeaves : snap.birthLeaves
					const root = origin === 0 ? snap.poolRoot : snap.birthRoot
					const offset = leaves.indexOf(aspLeaf(probe))
					const path = pathFor(snap, probe, origin)
					if (offset < 0) {
						expect(path).toBeNull()
						return
					}
					expect(path).toEqual(buildLeanImt(leaves).path(offset))
					assertLeanImtMember(aspLeaf(probe), path!, root)
				}),
				paths.fc,
			)
		},
		paths.testTimeout,
	)
})
