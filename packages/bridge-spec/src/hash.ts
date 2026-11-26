import { poseidon1, poseidon2 } from "poseidon-lite"
import { assertField } from "./fields"

// poseidon-lite reduces inputs mod p silently, so every input is range-checked first.

/** The pool's circom Poseidon over one input; equals Noir `pp_hash::hash_1`. */
export const circomPoseidon1 = (x: bigint): bigint => poseidon1([assertField(x, "x")])

/** The pool's circom Poseidon over two inputs; equals Noir `pp_hash::hash_2`. */
export const circomPoseidon2 = (a: bigint, b: bigint): bigint => poseidon2([assertField(a, "a"), assertField(b, "b")])

/** A pool note commitment, `Poseidon(precommitment, label)`. */
export const changeCommitment = (precommitment: bigint, label: bigint): bigint => circomPoseidon2(precommitment, label)

/** The ASP tree's leaf for a label, `Poseidon(label)`. */
export const aspLeaf = (label: bigint): bigint => circomPoseidon1(label)
