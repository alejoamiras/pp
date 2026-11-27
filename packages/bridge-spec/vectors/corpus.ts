/**
 * The v1 vector corpus, computed by the TS reference. `gen.ts` renders it twice (v1.json and the
 * keystone's vectors_v1.nr); the suites check Solidity and Noir against those files, never each other.
 */
import { Fr } from "@aztec-labs/foundation/curves/bn254"
import { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { sha256 } from "@noble/hashes/sha2"
import { type Hex, parseSignature, serializeCompactSignature, signatureToCompactSignature } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { birthId, birthLabel, birthNullifier, siloedBirthNullifier } from "../src/birth"
import { deriveClaimKey, deriveClaimSalt } from "../src/claim"
import { deriveTokenClaimSecret, tokenClaimSecretHash } from "../src/claim-secret"
import { bridgeContentPreimageV1, bridgeDataV1, exitContentPreimageV1, ragequitContentPreimageV1, sha256ToField } from "../src/encode"
import { BN254_P, bytesToBigInt, concat, toHex, U128_MAX, U160_LIMIT, word } from "../src/fields"
import { aspLeaf, changeCommitment, circomPoseidon1, circomPoseidon2 } from "../src/hash"
import { buildLeanImt, MAX_DEPTH } from "../src/lean-imt"
import { TAG_STRINGS, TAGS } from "../src/tags"
import { REJECTIONS, type Rejection } from "./rejections"
import { SPIKE } from "./spike"

export const P = BN254_P
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

export const h32 = (v: bigint): Hex => `0x${v.toString(16).padStart(64, "0")}`
export const addr = (v: bigint): Hex => `0x${v.toString(16).padStart(40, "0")}`

const utf8 = (s: string) => new TextEncoder().encode(s)
const PREFIX = utf8("pp.bridge.vectors.v1")

/**
 * Case `i` of `section`: `seed = sha256("pp.bridge.vectors.v1" ‖ fresh ‖ section ‖ be32(i))`, then
 * `sha256(seed ‖ be32(j))` per draw. `fresh` is empty for the committed corpus, else a decimal seed,
 * which cannot run into a section name because those start with a letter.
 */
export function seeded(section: string, i: number, fresh = "") {
	const seed = sha256(concat([PREFIX, utf8(fresh), utf8(section), word(BigInt(i))]))
	let j = 0
	const bytes = () => sha256(concat([seed, word(BigInt(j++))]))
	const next = () => bytesToBigInt(bytes())
	return {
		bytes,
		field: () => next() % P,
		nonZeroField: () => (next() % (P - 1n)) + 1n,
		amount: () => (next() % U128_MAX) + 1n,
		payee: () => (next() % (U160_LIMIT - 1n)) + 1n,
		privateKey: () => h32((next() % (SECP256K1_N - 1n)) + 1n),
	}
}

const SEEDED = 64
const range = (n: number) => Array.from({ length: n }, (_, i) => i)

function tags() {
	return (Object.keys(TAGS) as (keyof typeof TAGS)[]).map((name) => ({ name, ascii: TAG_STRINGS[name], value: TAGS[name] }))
}

function data(fresh: string) {
	const inputs = [1n, P - 1n, ...range(SEEDED).map((i) => seeded("data", i, fresh).nonZeroField())]
	return inputs.map((s) => ({ secretHash: h32(s), data: bridgeDataV1(h32(s)) }))
}

function bridgeIn(fresh: string) {
	const b = seeded("in.base", 0, fresh)
	const base = { nullifier: b.field(), changeCommitment: b.field(), amount: b.amount() }
	const edges = [
		...[1n, 1n << 64n, U128_MAX].map((amount) => ({ ...base, amount })),
		...[0n, 1n, P - 1n].map((nullifier) => ({ ...base, nullifier })),
		...[0n, 1n, P - 1n].map((changeCommitment) => ({ ...base, changeCommitment })),
	]
	const cases = [
		...edges,
		...range(SEEDED).map((i) => {
			const s = seeded("in", i, fresh)
			return { nullifier: s.field(), changeCommitment: s.field(), amount: s.amount() }
		}),
	]
	return cases.map((c) => {
		const preimage = bridgeContentPreimageV1(c)
		const fields = { nullifier: h32(c.nullifier), changeCommitment: h32(c.changeCommitment), amount: h32(c.amount) }
		return { ...fields, preimage: toHex(preimage), content: h32(sha256ToField(preimage)) }
	})
}

function exitCases(section: "out" | "ragequit", fresh: string) {
	const b = seeded(`${section}.base`, 0, fresh)
	const base = { payee: b.payee(), amount: b.amount(), label: b.nonZeroField() }
	const edges = [
		...[1n, 1n << 64n, U128_MAX].map((amount) => ({ ...base, amount })),
		...[1n, U160_LIMIT - 1n].map((payee) => ({ ...base, payee })),
		...(section === "ragequit" ? [1n, P - 1n].map((label) => ({ ...base, label })) : []),
	]
	const seededCases = range(SEEDED).map((i) => {
		const s = seeded(section, i, fresh)
		return { payee: s.payee(), amount: s.amount(), label: s.nonZeroField() }
	})
	return [...edges, ...seededCases]
}

function out(fresh: string) {
	return exitCases("out", fresh).map(({ payee, amount }) => {
		const preimage = exitContentPreimageV1({ payee: addr(payee), amount })
		return { payee: addr(payee), amount: h32(amount), preimage: toHex(preimage), content: h32(sha256ToField(preimage)) }
	})
}

function ragequit(fresh: string) {
	return exitCases("ragequit", fresh).map(({ payee, amount, label }) => {
		const preimage = ragequitContentPreimageV1({ payee: addr(payee), amount, label })
		const fields = { payee: addr(payee), amount: h32(amount), label: h32(label) }
		return { ...fields, preimage: toHex(preimage), content: h32(sha256ToField(preimage)) }
	})
}

function poseidon(fresh: string) {
	const draws = (section: string, n: number) =>
		range(16).map((i) => {
			const s = seeded(section, i, fresh)
			return range(n).map(() => s.field())
		})
	const hash1 = [...SPIKE.hash1.map((e) => [BigInt(e.x)]), ...draws("hash1", 1)].map(([x]) => ({
		x: h32(x as bigint),
		out: h32(circomPoseidon1(x as bigint)),
	}))
	const hash2 = [...SPIKE.hash2.map((e) => [BigInt(e.a), BigInt(e.b)]), ...draws("hash2", 2)].map(([a, b]) => ({
		a: h32(a as bigint),
		b: h32(b as bigint),
		out: h32(circomPoseidon2(a as bigint, b as bigint)),
	}))
	const pool = [BigInt(SPIKE.pool.precommitment), BigInt(SPIKE.pool.label)]
	const commitment = [pool, ...draws("commitment", 2)].map(([pre, label]) => ({
		precommitment: h32(pre as bigint),
		label: h32(label as bigint),
		commitment: h32(changeCommitment(pre as bigint, label as bigint)),
	}))
	const aspLeafCases = [[BigInt(SPIKE.pool.label)], ...draws("aspLeaf", 1)].map(([label]) => ({
		label: h32(label as bigint),
		leaf: h32(aspLeaf(label as bigint)),
	}))
	return { hash1, hash2, commitment, aspLeaf: aspLeafCases }
}

type PathCase = { name: string; label: Hex; leaf: Hex; root: Hex; index: number; depth: number; siblings: Hex[] }

function treeCases(size: number, leafIndices: readonly number[], fresh: string): PathCase[] {
	const labels = range(size).map((i) => seeded(`leanImt.${size}`, i, fresh).nonZeroField())
	const tree = buildLeanImt(labels.map(aspLeaf))
	return leafIndices.map((i) => {
		const path = tree.path(i)
		const label = labels[i] as bigint
		const fields = { label: h32(label), leaf: h32(aspLeaf(label)), root: h32(tree.root) }
		return { name: `tree${size}_leaf${i}`, ...fields, index: path.index, depth: path.depth, siblings: path.siblings.map(h32) }
	})
}

function leanImt(fresh: string): PathCase[] {
	const spike = SPIKE.memberships.map((m) => {
		const siblings = [...m.siblings.map((s) => BigInt(s)), ...Array<bigint>(MAX_DEPTH - m.siblings.length).fill(0n)]
		const label = BigInt(m.label)
		const fields = { label: h32(label), leaf: h32(aspLeaf(label)), root: h32(BigInt(m.root)) }
		return { name: `spike_${m.name}`, ...fields, index: m.index, depth: m.depth, siblings: siblings.map(h32) }
	})
	const full = [1, 2, 3, 4, 5, 7].flatMap((size) => treeCases(size, range(size), fresh))
	return [...full, ...treeCases(11, [3, 10], fresh), ...spike]
}

async function claimKey(fresh: string) {
	const sign = async (section: string, i: number) => {
		const s = seeded(section, i, fresh)
		const account = privateKeyToAccount(s.privateKey())
		return { account, signature: await account.signMessage({ message: { raw: s.bytes() } }) }
	}
	const first = await sign("claimKey", 0)
	const parsed = parseSignature(first.signature)
	const v01 = `${first.signature.slice(0, 130)}${(Number(parsed.v) - 27).toString(16).padStart(2, "0")}` as Hex
	const compact = serializeCompactSignature(signatureToCompactSignature(parsed))
	const forms = [first.signature, v01, compact].map((signature) => ({ signature, address: first.account.address }))
	const more = await Promise.all(range(4).map(async (i) => sign("claimKey", i + 1)))
	const cases = [...forms, ...more.map((m) => ({ signature: m.signature, address: m.account.address }))]
	return cases.map(({ signature, address }) => ({
		signature,
		l1Address: address.toLowerCase() as Hex,
		key: toHex(deriveClaimKey(signature, address)),
	}))
}

function claimSalt(fresh: string) {
	const cases = range(8).map((i) => {
		const s = seeded("claimSalt", i, fresh)
		const spent = i === 0 ? 0n : i === 1 ? P - 1n : s.field()
		return { key: s.bytes(), spent }
	})
	return cases.map(({ key, spent }) => ({ key: toHex(key), spentCommitment: h32(spent), salt: h32(deriveClaimSalt(key, spent)) }))
}

async function claimSecretHash(fresh: string) {
	const keystone: [bigint, bigint][] = [
		[0n, 0n],
		[1n, 2n],
		[0x1234567890abcdefn, 0xdeadbeefn],
	]
	const more = range(5).map((i): [bigint, bigint] => {
		const s = seeded("claimSecretHash", i, fresh)
		return [s.field(), s.field()]
	})
	return Promise.all(
		[...keystone, ...more].map(async ([salt, recipient]) => {
			const r = AztecAddress.fromBigIntUnsafe(recipient)
			const secret = deriveTokenClaimSecret(new Fr(salt), r).toBigInt()
			const secretHash = (await tokenClaimSecretHash(new Fr(salt), r)).toBigInt()
			return { salt: h32(salt), recipient: h32(recipient), secret: h32(secret), secretHash: h32(secretHash) }
		}),
	)
}

async function birth(fresh: string) {
	const b = seeded("birth.base", 0, fresh)
	const base = { token: b.field(), owner: b.field(), amount: b.amount(), birthSecret: b.nonZeroField() }
	const edges = [
		{ ...base, amount: 1n },
		{ ...base, amount: U128_MAX },
		{ ...base, birthSecret: 1n },
		{ ...base, birthSecret: P - 1n },
	]
	const more = range(8).map((i) => {
		const s = seeded("birth", i, fresh)
		return { token: s.field(), owner: s.field(), amount: s.amount(), birthSecret: s.nonZeroField() }
	})
	return Promise.all(
		[...edges, ...more].map(async (c) => {
			const token = AztecAddress.fromBigIntUnsafe(c.token)
			const owner = AztecAddress.fromBigIntUnsafe(c.owner)
			const label = birthLabel({ token, owner, amount: c.amount, birthSecret: c.birthSecret })
			const nullifier = birthNullifier({ owner, birthSecret: c.birthSecret })
			const siloed = await siloedBirthNullifier({ token, owner, birthSecret: c.birthSecret })
			const id = birthId({ label, birthSecret: c.birthSecret })
			const inputs = { token: h32(c.token), owner: h32(c.owner), amount: h32(c.amount), birthSecret: h32(c.birthSecret) }
			return { ...inputs, label: h32(label), nullifier: h32(nullifier), siloedNullifier: h32(siloed), birthId: h32(id) }
		}),
	)
}

export type Corpus = Awaited<ReturnType<typeof buildSections>> & { counts: Record<string, number>; noirTests: string[] }

async function buildSections(fresh: string) {
	return {
		tags: tags(),
		data: data(fresh),
		in: bridgeIn(fresh),
		out: out(fresh),
		ragequit: ragequit(fresh),
		rejections: REJECTIONS as readonly Rejection[],
		...poseidon(fresh),
		leanImt: leanImt(fresh),
		claimKey: await claimKey(fresh),
		claimSalt: claimSalt(fresh),
		claimSecretHash: await claimSecretHash(fresh),
		birth: await birth(fresh),
	}
}

/**
 * The corpus `gen.ts` commits when `seed` is omitted. A seed (a non-negative safe integer) draws every
 * seeded case afresh and keeps every section's size, so the suites' hand-written counts still hold.
 *
 * @throws Error when `seed` is not a non-negative safe integer
 */
export async function buildCorpus(
	noirTests: (sections: Awaited<ReturnType<typeof buildSections>>) => string[],
	seed?: number,
): Promise<Corpus> {
	if (seed !== undefined && !(Number.isSafeInteger(seed) && seed >= 0))
		throw new Error(`corpus seed must be a non-negative integer, got ${seed}`)
	const sections = await buildSections(seed === undefined ? "" : String(seed))
	const counts = Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.length]))
	return { ...sections, counts, noirTests: noirTests(sections) }
}
