use poseidon::poseidon::bn254::hash_2;

pub global MAX_DEPTH: u32 = 18;

/// Recomputes a LeanIMT root from a leaf in @zk-kit/lean-imt's proof format: `depth` is the number of siblings
/// (a lone left child is promoted unhashed, so it is not the tree height), and bit `i` of `index` is 1 when the
/// node is the right child at sibling `i`. Bits of `index` past `depth` are rejected; siblings past `depth` are
/// ignored, so a membership has many encodings and nothing may be derived from the path itself.
pub fn lean_imt_root(leaf: Field, depth: u32, index: u32, siblings: [Field; MAX_DEPTH]) -> Field {
    assert(depth <= MAX_DEPTH, "depth above 18");
    assert((index as u64) < (1 as u64 << depth as u64), "index bits above depth");
    let mut node = leaf;
    for i in 0..MAX_DEPTH {
        // Order the pair first, then hash once: hashing inside each branch of a runtime `if` costs both hashes.
        let right = ((index >> i) & 1) == 1;
        let (l, r) = if right {
            (siblings[i], node)
        } else {
            (node, siblings[i])
        };
        let parent = hash_2([l, r]);
        node = if i < depth { parent } else { node };
    }
    node
}
