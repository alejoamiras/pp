//! The pool's circom Poseidon and LeanIMT membership, plus the birth hashes of Aztec-born labels.
//! Mirrored by `@pp/bridge-spec` (TS) and checked against its generated vectors in keystone.
//! Assert messages are the shared rejection names.

pub mod birth;
mod test;

use aztec::protocol::traits::{Deserialize, Serialize};
use poseidon::poseidon::bn254;

pub global MAX_DEPTH: u32 = 18;

/// A path in `@zk-kit/lean-imt`'s proof format. `depth` counts siblings (a lone left child is promoted
/// unhashed, so it is not the tree height); bit `i` of `index` is 1 when the node is the right child at
/// level `i`; siblings past `depth` are 0. The note's origin, not the path, selects the tree.
#[derive(Deserialize, Eq, Serialize)]
pub struct LabelPath {
    pub index: u32,
    pub depth: u8,
    pub siblings: [Field; MAX_DEPTH],
}

/// circom Poseidon over one input (the ASP leaf is `hash_1([label])`).
pub fn hash_1(inputs: [Field; 1]) -> Field {
    bn254::hash_1(inputs)
}

/// circom Poseidon over two inputs (a pool commitment, a LeanIMT node).
pub fn hash_2(inputs: [Field; 2]) -> Field {
    bn254::hash_2(inputs)
}

/// The root `path` implies for `leaf`. Asserts `depth <= 18`, `index < 2^depth` and zero siblings past
/// `depth`, so the padding is canonical. Equal siblings leave that level's direction bit free: a path
/// proves membership, never a position.
pub fn lean_imt_root(leaf: Field, path: LabelPath) -> Field {
    let depth = path.depth as u32;
    assert(depth <= MAX_DEPTH, "DepthOutOfRange");
    assert((path.index as u64) < (1 as u64 << depth as u64), "IndexOutOfRange");
    let mut node = leaf;
    for i in 0..MAX_DEPTH {
        let active = i < depth;
        let sibling = path.siblings[i];
        assert(active | (sibling == 0), "SiblingOutOfRange");
        // Order the pair, then hash once: a hash inside each branch of a runtime `if` costs both.
        let (l, r) = if ((path.index >> i) & 1) == 1 {
            (sibling, node)
        } else {
            (node, sibling)
        };
        let parent = hash_2([l, r]);
        node = if active { parent } else { node };
    }
    node
}

/// `leaf` is in the tree with `root`. An empty tree's root (0) admits nothing.
pub fn assert_lean_imt_member(leaf: Field, path: LabelPath, root: Field) {
    let computed = lean_imt_root(leaf, path);
    assert(root != 0, "ZeroRoot");
    assert(computed == root, "NotMember");
}
