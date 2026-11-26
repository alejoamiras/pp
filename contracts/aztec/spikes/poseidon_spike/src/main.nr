pub mod imt;
mod test;
mod vectors;

use aztec::macros::aztec;

#[aztec]
pub contract PoseidonSpike {
    use crate::imt::{lean_imt_root, MAX_DEPTH};
    use aztec::macros::functions::external;
    use poseidon::poseidon::bn254::{hash_1, hash_2};

    /// Does nothing: its gate count is the fixed cost of a private function, to subtract from the others.
    #[external("private")]
    fn baseline() {}

    /// The pool's note commitment, `Poseidon(precommitment, label)`.
    #[external("private")]
    fn pool_commitment(precommitment: Field, label: Field) -> Field {
        hash_2([precommitment, label])
    }

    /// The ASP tree's leaf for a label, `Poseidon(label)`.
    #[external("private")]
    fn asp_leaf(label: Field) -> Field {
        hash_1([label])
    }

    /// Proves `label` is a leaf of the ASP tree with `root`.
    #[external("private")]
    fn asp_member(label: Field, root: Field, depth: u32, index: u32, siblings: [Field; MAX_DEPTH]) {
        assert(lean_imt_root(hash_1([label]), depth, index, siblings) == root, "label not in root");
    }
}
