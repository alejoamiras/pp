import type { Corpus } from "./corpus"
import type { Rejection } from "./rejections"

type Sections = Omit<Corpus, "counts" | "noirTests">

/** Minimal hex: Noir reads it for both `Field` and `u128`. */
const n = (hex: string) => `0x${BigInt(hex).toString(16)}`
const tuple = (xs: readonly string[]) => `(${xs.join(", ")})`
const path = (p: { index: number; depth: number; siblings: readonly string[] }) =>
	`LabelPath { index: ${p.index}, depth: ${p.depth}, siblings: [${p.siblings.map(n).join(", ")}] }`

// Unconstrained: the same functions run as Brillig, so section loops need no unrolling. The loop runs
// to `cases.len()`, never a literal, so it covers every row; nargo-check.ts requires that bound.
const NOIR_LOOP = "    for i in 0..cases.len() {"

function sectionTest(name: string, type: string, rows: readonly string[], body: string): string {
	return [
		"#[test]",
		`unconstrained fn v1_${name}() {`,
		`    let cases: [${type}; ${rows.length}] = [`,
		...rows.map((r) => `        ${r},`),
		"    ];",
		NOIR_LOOP,
		body,
		"    }",
		"}",
	].join("\n")
}

const SECTION_TESTS: Record<string, (s: Sections) => string> = {
	tags: (s) => {
		const byName = Object.fromEntries(s.tags.map((t, i) => [t.name, { i, v: n(t.value) }]))
		const line = (glob: string, key: string) => `    assert(${glob} == ${byName[key]?.v}, "tags[${byName[key]?.i}]");`
		return [
			"#[test]",
			"fn v1_tags() {",
			line("PP_BRIDGE_IN_V1", "IN_V1"),
			line("PP_BRIDGE_OUT_V1", "OUT_V1"),
			line("PP_BRIDGE_RAGEQUIT_V1", "RAGEQUIT_V1"),
			"}",
		].join("\n")
	},
	in: (s) =>
		sectionTest(
			"in",
			"(Field, Field, u128, Field)",
			s.in.map((c) => tuple([c.nullifier, c.changeCommitment, c.amount, c.content].map(n))),
			'        let (nullifier, change, amount, content) = cases[i];\n        assert(bridge_content_v1(nullifier, change, amount) == content, f"in[{i}]");',
		),
	out: (s) =>
		sectionTest(
			"out",
			"(Field, u128, Field)",
			s.out.map((c) => tuple([c.payee, c.amount, c.content].map(n))),
			'        let (payee, amount, content) = cases[i];\n        assert(exit_content_v1(EthAddress::from_field(payee), amount) == content, f"out[{i}]");',
		),
	ragequit: (s) =>
		sectionTest(
			"ragequit",
			"(Field, u128, Field, Field)",
			s.ragequit.map((c) => tuple([c.payee, c.amount, c.label, c.content].map(n))),
			'        let (payee, amount, label, content) = cases[i];\n        assert(ragequit_content_v1(EthAddress::from_field(payee), amount, label) == content, f"ragequit[{i}]");',
		),
	hash1: (s) =>
		sectionTest(
			"hash1",
			"(Field, Field)",
			s.hash1.map((c) => tuple([c.x, c.out].map(n))),
			'        let (x, out) = cases[i];\n        assert(hash_1([x]) == out, f"hash1[{i}]");',
		),
	hash2: (s) =>
		sectionTest(
			"hash2",
			"(Field, Field, Field)",
			s.hash2.map((c) => tuple([c.a, c.b, c.out].map(n))),
			'        let (a, b, out) = cases[i];\n        assert(hash_2([a, b]) == out, f"hash2[{i}]");',
		),
	commitment: (s) =>
		sectionTest(
			"commitment",
			"(Field, Field, Field)",
			s.commitment.map((c) => tuple([c.precommitment, c.label, c.commitment].map(n))),
			'        let (precommitment, label, commitment) = cases[i];\n        assert(hash_2([precommitment, label]) == commitment, f"commitment[{i}]");',
		),
	aspLeaf: (s) =>
		sectionTest(
			"asp_leaf",
			"(Field, Field)",
			s.aspLeaf.map((c) => tuple([c.label, c.leaf].map(n))),
			'        let (label, leaf) = cases[i];\n        assert(hash_1([label]) == leaf, f"aspLeaf[{i}]");',
		),
	leanImt: (s) =>
		sectionTest(
			"lean_imt",
			"(Field, Field, Field, LabelPath)",
			s.leanImt.map((c) => tuple([n(c.label), n(c.leaf), n(c.root), path(c)])),
			[
				"        let (label, leaf, root, path) = cases[i];",
				'        assert(hash_1([label]) == leaf, f"leanImt[{i}]");',
				'        assert(lean_imt_root(leaf, path) == root, f"leanImt[{i}]");',
				"        assert_lean_imt_member(leaf, path, root);",
			].join("\n"),
		),
	claimSecretHash: (s) =>
		sectionTest(
			"claim_secret_hash",
			"(Field, Field, Field, Field)",
			s.claimSecretHash.map((c) => tuple([c.salt, c.recipient, c.secret, c.secretHash].map(n))),
			[
				"        let (salt, recipient, secret, secret_hash) = cases[i];",
				'        assert(derive_claim_secret(salt, AztecAddress::from_field(recipient)) == secret, f"claimSecretHash[{i}]");',
				'        assert(compute_secret_hash([secret]) == secret_hash, f"claimSecretHash[{i}]");',
			].join("\n"),
		),
	birth: (s) =>
		sectionTest(
			"birth",
			"(Field, Field, u128, Field, Field, Field, Field, Field)",
			s.birth.map((c) =>
				tuple([c.token, c.owner, c.amount, c.birthSecret, c.label, c.nullifier, c.siloedNullifier, c.birthId].map(n)),
			),
			[
				"        let (token, owner, amount, secret, label, nullifier, siloed, id) = cases[i];",
				"        let (token, owner) = (AztecAddress::from_field(token), AztecAddress::from_field(owner));",
				'        assert(birth_label(token, owner, amount, secret) == label, f"birth[{i}]");',
				'        assert(birth_nullifier(owner, secret) == nullifier, f"birth[{i}]");',
				'        assert(compute_siloed_nullifier(token, nullifier) == siloed, f"birth[{i}]");',
				'        assert(birth_id(label, secret) == id, f"birth[{i}]");',
			].join("\n"),
		),
}

const arg = (r: Rejection, k: string) => n(r.args[k] as string)
const wordPayee = (r: Rejection) => `EthAddress::deserialize([${arg(r, "payee")}])`

const REJECTION_CALLS: Partial<Record<Rejection["fn"], (r: Rejection) => string>> = {
	bridgeContent: (r) => `bridge_content_v1(${arg(r, "nullifier")}, ${arg(r, "changeCommitment")}, ${arg(r, "amount")})`,
	// Deserialize, not from_field: from_field would reject a wide payee before the encoder sees it.
	exitContent: (r) => `exit_content_v1(${wordPayee(r)}, ${arg(r, "amount")})`,
	ragequitContent: (r) => `ragequit_content_v1(${wordPayee(r)}, ${arg(r, "amount")}, ${arg(r, "label")})`,
	leanImtRoot: (r) => `lean_imt_root(${arg(r, "leaf")}, ${path(r.args as never)})`,
	assertLeanImtMember: (r) => `assert_lean_imt_member(${arg(r, "leaf")}, ${path(r.args as never)}, ${arg(r, "root")})`,
}

export const rejectionTestName = (r: Rejection, i: number) => `v1_rejection_${String(i).padStart(2, "0")}_${r.name}`

function rejectionTests(s: Sections): string[] {
	return s.rejections.flatMap((r, i) => {
		if (!r.langs.includes("nr")) return []
		const call = REJECTION_CALLS[r.fn]
		if (call === undefined) throw new Error(`rejections[${i}]: no Noir call for ${r.fn}`)
		return [`#[test(should_fail_with = "${r.error}")]\nunconstrained fn ${rejectionTestName(r, i)}() {\n    let _ = ${call(r)};\n}`]
	})
}

/** The generated Noir test names, in file order; `v1.json`'s `noirTests` and `nargo-check.ts` use them. */
export function noirTestNames(s: Sections): string[] {
	const sections = ["tags", "in", "out", "ragequit", "hash1", "hash2", "commitment", "asp_leaf", "lean_imt", "claim_secret_hash", "birth"]
	return [...sections.map((x) => `v1_${x}`), ...s.rejections.flatMap((r, i) => (r.langs.includes("nr") ? [rejectionTestName(r, i)] : []))]
}

const HEADER = `// Generated by packages/bridge-spec/vectors/gen.ts from the corpus that also renders
// packages/bridge-spec/vectors/v1.json. Do not edit: run \`bun run --cwd packages/bridge-spec vectors\`.
// A failing assertion names the JSON section and index of the vector.

use aztec::hash::{compute_secret_hash, compute_siloed_nullifier};
use aztec::protocol::address::{AztecAddress, EthAddress};
use aztec::protocol::traits::{Deserialize, FromField};
use bridge_message::{
    bridge_content_v1, exit_content_v1, PP_BRIDGE_IN_V1, PP_BRIDGE_OUT_V1, PP_BRIDGE_RAGEQUIT_V1, ragequit_content_v1,
};
use claim_secret_lib::derive_claim_secret;
use pp_hash::{assert_lean_imt_member, hash_1, hash_2, LabelPath, lean_imt_root};
use pp_hash::birth::{birth_id, birth_label, birth_nullifier};
`

export function renderNoir(s: Sections): string {
	const order = ["tags", "in", "out", "ragequit", "hash1", "hash2", "commitment", "aspLeaf", "leanImt", "claimSecretHash", "birth"]
	const tests = order.map((k) => (SECTION_TESTS[k] as (s: Sections) => string)(s))
	return `${HEADER}\n${[...tests, ...rejectionTests(s)].join("\n\n")}\n`
}
