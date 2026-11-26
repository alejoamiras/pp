import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import type { Hex } from "viem"
import { describe, expect, it } from "vitest"
import { birthId, birthLabel, birthNullifier, siloedBirthNullifier } from "./birth"
import { deriveClaimKey, deriveClaimSalt } from "./claim"
import { deriveTokenClaimSecret, tokenClaimSecretHash } from "./claim-secret"
import {
	bridgeContentPreimageV1,
	bridgeContentV1,
	bridgeDataV1,
	exitContentPreimageV1,
	exitContentV1,
	ragequitContentPreimageV1,
	ragequitContentV1,
} from "./encode"
import { hexBytes, SpecRangeError, toHex, U160_LIMIT } from "./fields"
import { aspLeaf, changeCommitment, circomPoseidon1, circomPoseidon2 } from "./hash"
import { assertLeanImtMember, type LabelPath, leanImtRoot } from "./lean-imt"
import { TAGS, tagWord } from "./tags"

/**
 * What the vectors must contain is written here by hand, never read from the generated file: a
 * generator that drops a section, a vector or a rejection name together with its count still fails.
 */
const FLOORS: Record<string, number> = {
	tags: 4,
	data: 66,
	in: 73,
	out: 69,
	ragequit: 71,
	rejections: 23,
	hash1: 20,
	hash2: 19,
	commitment: 17,
	aspLeaf: 17,
	leanImt: 31,
	claimKey: 7,
	claimSalt: 8,
	claimSecretHash: 8,
	birth: 12,
}
const TS_REJECTION_CODES = [
	"SecretHashOutOfRange",
	"FieldOutOfRange",
	"AmountOutOfRange",
	"ZeroPayee",
	"PayeeOutOfRange",
	"LabelOutOfRange",
	"DepthOutOfRange",
	"IndexOutOfRange",
	"SiblingOutOfRange",
	"ZeroRoot",
	"NotMember",
]

type Row = Record<string, string | number | string[] | readonly string[]>
const VECTORS_PATH = process.env.BRIDGE_SPEC_VECTORS ?? resolve(__dirname, "../vectors/v1.json")
const V = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as Record<string, Row[]> & { counts: Record<string, number> }

const b = (v: unknown) => BigInt(v as string)
const s = (v: unknown) => v as Hex
const aztec = (v: unknown) => AztecAddress.fromBigIntUnsafe(b(v))
const pathOf = (r: Row): LabelPath => ({ index: r.index as number, depth: r.depth as number, siblings: (r.siblings as string[]).map(b) })
/** A payee word ≥ 2^160 becomes a 21-byte hex, which the encoder must refuse as it refuses the word. */
const payeeOf = (word: unknown): Hex => {
	const v = b(word)
	return `0x${v.toString(16).padStart(v < U160_LIMIT ? 40 : 42, "0")}`
}
const rows = (section: string) => V[section] ?? []

function forEachRow(section: string, check: (r: Row, at: string) => void): void {
	for (const [i, r] of rows(section).entries()) check(r, `${section}[${i}]`)
}

async function forEachRowAsync(section: string, check: (r: Row, at: string) => Promise<void>): Promise<void> {
	for (const [i, r] of rows(section).entries()) await check(r, `${section}[${i}]`)
}

const REJECT: Record<string, (a: Row) => unknown> = {
	bridgeData: (a) => bridgeDataV1(s(a.secretHash)),
	bridgeContent: (a) => bridgeContentV1({ nullifier: b(a.nullifier), changeCommitment: b(a.changeCommitment), amount: b(a.amount) }),
	exitContent: (a) => exitContentV1({ payee: payeeOf(a.payee), amount: b(a.amount) }),
	ragequitContent: (a) => ragequitContentV1({ payee: payeeOf(a.payee), amount: b(a.amount), label: b(a.label) }),
	leanImtRoot: (a) => leanImtRoot(b(a.leaf), pathOf(a)),
	assertLeanImtMember: (a) => assertLeanImtMember(b(a.leaf), pathOf(a), b(a.root)),
	birthLabel: (a) => birthLabel({ token: aztec(a.token), owner: aztec(a.owner), amount: b(a.amount), birthSecret: b(a.birthSecret) }),
}

function codeOf(f: () => unknown): string {
	try {
		f()
	} catch (e) {
		return e instanceof SpecRangeError ? e.code : `unexpected ${String(e)}`
	}
	return "no rejection"
}

describe(`v1 vectors (${VECTORS_PATH.endsWith("vectors/v1.json") ? "committed" : "override"})`, () => {
	it("counts: every required section is present, matches its count and meets its floor", () => {
		for (const [section, floor] of Object.entries(FLOORS)) {
			expect(rows(section).length, `${section} length`).toBe(V.counts[section])
			expect(rows(section).length, `${section} floor`).toBeGreaterThanOrEqual(floor)
		}
	})

	it("tags", () => {
		forEachRow("tags", (r, at) => {
			expect(TAGS[r.name as keyof typeof TAGS], at).toBe(r.value)
			expect(tagWord(r.ascii as string), at).toBe(b(r.value))
		})
	})

	it("data", () => {
		forEachRow("data", (r, at) => expect(bridgeDataV1(s(r.secretHash)), at).toBe(r.data))
	})

	it("in", () => {
		forEachRow("in", (r, at) => {
			const a = { nullifier: b(r.nullifier), changeCommitment: b(r.changeCommitment), amount: b(r.amount) }
			expect(toHex(bridgeContentPreimageV1(a)), at).toBe(r.preimage)
			expect(bridgeContentV1(a), at).toBe(b(r.content))
		})
	})

	it("out", () => {
		forEachRow("out", (r, at) => {
			const a = { payee: s(r.payee), amount: b(r.amount) }
			expect(toHex(exitContentPreimageV1(a)), at).toBe(r.preimage)
			expect(exitContentV1(a), at).toBe(b(r.content))
		})
	})

	it("ragequit", () => {
		forEachRow("ragequit", (r, at) => {
			const a = { payee: s(r.payee), amount: b(r.amount), label: b(r.label) }
			expect(toHex(ragequitContentPreimageV1(a)), at).toBe(r.preimage)
			expect(ragequitContentV1(a), at).toBe(b(r.content))
		})
	})

	it("rejections", () => {
		const ts = rows("rejections").filter((r) => (r.langs as string[]).includes("ts"))
		expect(new Set(ts.map((r) => r.error)), "rejection codes").toEqual(new Set(TS_REJECTION_CODES))
		forEachRow("rejections", (r, at) => {
			if (!(r.langs as string[]).includes("ts")) return
			const call = REJECT[r.fn as string]
			expect(call, `${at} fn`).toBeDefined()
			expect(
				codeOf(() => call?.(r.args as unknown as Row)),
				`${at} ${r.name}`,
			).toBe(r.error)
		})
	})

	it("hash1", () => forEachRow("hash1", (r, at) => expect(circomPoseidon1(b(r.x)), at).toBe(b(r.out))))
	it("hash2", () => forEachRow("hash2", (r, at) => expect(circomPoseidon2(b(r.a), b(r.b)), at).toBe(b(r.out))))
	it("commitment", () =>
		forEachRow("commitment", (r, at) => expect(changeCommitment(b(r.precommitment), b(r.label)), at).toBe(b(r.commitment))))
	it("aspLeaf", () => forEachRow("aspLeaf", (r, at) => expect(aspLeaf(b(r.label)), at).toBe(b(r.leaf))))

	it("leanImt", () => {
		forEachRow("leanImt", (r, at) => {
			expect(aspLeaf(b(r.label)), at).toBe(b(r.leaf))
			expect(leanImtRoot(b(r.leaf), pathOf(r)), at).toBe(b(r.root))
			expect(
				codeOf(() => assertLeanImtMember(b(r.leaf), pathOf(r), b(r.root))),
				at,
			).toBe("no rejection")
		})
	})

	it("claimKey", () => {
		forEachRow("claimKey", (r, at) => expect(toHex(deriveClaimKey(s(r.signature), s(r.l1Address))), at).toBe(r.key))
	})

	it("claimSalt", () => {
		forEachRow("claimSalt", (r, at) => {
			const key = hexBytes(r.key as string, 32) as Uint8Array
			expect(deriveClaimSalt(key, b(r.spentCommitment)), at).toBe(b(r.salt))
		})
	})

	it("claimSecretHash", async () => {
		await forEachRowAsync("claimSecretHash", async (r, at) => {
			const [salt, recipient] = [new Fr(b(r.salt)), aztec(r.recipient)]
			expect(deriveTokenClaimSecret(salt, recipient).toBigInt(), at).toBe(b(r.secret))
			expect((await tokenClaimSecretHash(salt, recipient)).toBigInt(), at).toBe(b(r.secretHash))
		})
	})

	it("birth", async () => {
		await forEachRowAsync("birth", async (r, at) => {
			const [token, owner, birthSecret] = [aztec(r.token), aztec(r.owner), b(r.birthSecret)]
			const label = birthLabel({ token, owner, amount: b(r.amount), birthSecret })
			expect(label, at).toBe(b(r.label))
			expect(birthNullifier({ owner, birthSecret }), at).toBe(b(r.nullifier))
			expect(await siloedBirthNullifier({ token, owner, birthSecret }), at).toBe(b(r.siloedNullifier))
			expect(birthId({ label, birthSecret }), at).toBe(b(r.birthId))
		})
	})
})
