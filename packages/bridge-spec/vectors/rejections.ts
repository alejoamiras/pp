import type { SpecErrorCode } from "../src/fields"
import { BN254_P, U128_MAX, U160_LIMIT } from "../src/fields"
import { MAX_DEPTH } from "../src/lean-imt"

/** Which implementations can even hold the input: Solidity's `address` and Noir's `Field`/`u128` cannot hold some. */
export type Lang = "ts" | "sol" | "nr"

export type Rejection = {
	/** snake_case; the Noir test is `v1_rejection_<index>_<name>`. */
	name: string
	fn: "bridgeData" | "bridgeContent" | "exitContent" | "ragequitContent" | "leanImtRoot" | "assertLeanImtMember" | "birthLabel"
	langs: readonly Lang[]
	/** Every number a 32-byte hex word (a payee too, since one case is ≥ 2^160); `index` and `depth` integers. */
	args: Readonly<Record<string, string | number | readonly string[]>>
	error: SpecErrorCode
}

const w = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`
const P = BN254_P
const ALL: readonly Lang[] = ["ts", "sol", "nr"]
const TS_SOL: readonly Lang[] = ["ts", "sol"]
const TS_NR: readonly Lang[] = ["ts", "nr"]

const ONE = w(1n)
const PAYEE = w(0x44a4n)
const siblings = (...head: bigint[]) => [...head, ...Array<bigint>(MAX_DEPTH - head.length).fill(0n)].map(w)

const content = { nullifier: ONE, changeCommitment: ONE, amount: ONE }
const exit = { payee: PAYEE, amount: ONE }
const rq = { payee: PAYEE, amount: ONE, label: ONE }
const leaf = w(0x1234n)

export const REJECTIONS: readonly Rejection[] = [
	{ name: "data_secret_hash_zero", fn: "bridgeData", langs: TS_SOL, args: { secretHash: w(0n) }, error: "SecretHashOutOfRange" },
	{ name: "data_secret_hash_p", fn: "bridgeData", langs: TS_SOL, args: { secretHash: w(P) }, error: "SecretHashOutOfRange" },
	{ name: "in_nullifier_p", fn: "bridgeContent", langs: TS_SOL, args: { ...content, nullifier: w(P) }, error: "FieldOutOfRange" },
	{ name: "in_change_p", fn: "bridgeContent", langs: TS_SOL, args: { ...content, changeCommitment: w(P) }, error: "FieldOutOfRange" },
	{ name: "in_amount_zero", fn: "bridgeContent", langs: ALL, args: { ...content, amount: w(0n) }, error: "AmountOutOfRange" },
	{
		name: "in_amount_2_128",
		fn: "bridgeContent",
		langs: TS_SOL,
		args: { ...content, amount: w(U128_MAX + 1n) },
		error: "AmountOutOfRange",
	},
	{ name: "out_payee_zero", fn: "exitContent", langs: ALL, args: { ...exit, payee: w(0n) }, error: "ZeroPayee" },
	{ name: "out_payee_2_160", fn: "exitContent", langs: TS_NR, args: { ...exit, payee: w(U160_LIMIT) }, error: "PayeeOutOfRange" },
	{ name: "out_amount_zero", fn: "exitContent", langs: ALL, args: { ...exit, amount: w(0n) }, error: "AmountOutOfRange" },
	{ name: "out_amount_2_128", fn: "exitContent", langs: TS_SOL, args: { ...exit, amount: w(U128_MAX + 1n) }, error: "AmountOutOfRange" },
	{ name: "rq_payee_zero", fn: "ragequitContent", langs: ALL, args: { ...rq, payee: w(0n) }, error: "ZeroPayee" },
	{ name: "rq_payee_2_160", fn: "ragequitContent", langs: TS_NR, args: { ...rq, payee: w(U160_LIMIT) }, error: "PayeeOutOfRange" },
	{ name: "rq_amount_zero", fn: "ragequitContent", langs: ALL, args: { ...rq, amount: w(0n) }, error: "AmountOutOfRange" },
	{ name: "rq_amount_2_128", fn: "ragequitContent", langs: TS_SOL, args: { ...rq, amount: w(U128_MAX + 1n) }, error: "AmountOutOfRange" },
	{ name: "rq_label_zero", fn: "ragequitContent", langs: ALL, args: { ...rq, label: w(0n) }, error: "LabelOutOfRange" },
	{ name: "rq_label_p", fn: "ragequitContent", langs: TS_SOL, args: { ...rq, label: w(P) }, error: "LabelOutOfRange" },
	{
		name: "path_depth_19",
		fn: "leanImtRoot",
		langs: TS_NR,
		args: { leaf, index: 0, depth: 19, siblings: siblings() },
		error: "DepthOutOfRange",
	},
	{
		name: "path_index_bit_at_depth",
		fn: "leanImtRoot",
		langs: TS_NR,
		args: { leaf, index: 4, depth: 2, siblings: siblings(5n, 6n) },
		error: "IndexOutOfRange",
	},
	{
		name: "path_sibling_past_depth",
		fn: "leanImtRoot",
		langs: TS_NR,
		args: { leaf, index: 0, depth: 1, siblings: siblings(5n, 1n) },
		error: "SiblingOutOfRange",
	},
	{
		name: "path_sibling_p",
		fn: "leanImtRoot",
		langs: ["ts"],
		args: { leaf, index: 0, depth: 1, siblings: siblings(P) },
		error: "FieldOutOfRange",
	},
	{
		name: "member_root_zero",
		fn: "assertLeanImtMember",
		langs: TS_NR,
		args: { leaf, root: w(0n), index: 0, depth: 0, siblings: siblings() },
		error: "ZeroRoot",
	},
	{
		name: "member_wrong_root",
		fn: "assertLeanImtMember",
		langs: TS_NR,
		args: { leaf, root: w(0x1235n), index: 0, depth: 0, siblings: siblings() },
		error: "NotMember",
	},
	{
		name: "birth_amount_2_128",
		fn: "birthLabel",
		langs: ["ts"],
		args: { token: ONE, owner: ONE, amount: w(U128_MAX + 1n), birthSecret: ONE },
		error: "AmountOutOfRange",
	},
]
