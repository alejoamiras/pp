use crate::{assert_lean_imt_member, hash_1, hash_2, lean_imt_root, LabelPath, MAX_DEPTH};
use crate::birth::{
    birth_id, birth_label, birth_nullifier, DOM_SEP__PP_BIRTH_ID, DOM_SEP__PP_BIRTH_LABEL,
    DOM_SEP__PP_BIRTH_NULLIFIER,
};
use aztec::hash::compute_siloed_nullifier;
use aztec::protocol::address::AztecAddress;
use aztec::protocol::traits::FromField;

fn siblings<let N: u32>(head: [Field; N]) -> [Field; MAX_DEPTH] {
    let mut out = [0; MAX_DEPTH];
    for i in 0..N {
        out[i] = head[i];
    }
    out
}

fn path<let N: u32>(index: u32, head: [Field; N]) -> LabelPath {
    LabelPath { index, depth: N as u8, siblings: siblings(head) }
}

#[test]
fn circom_poseidon_matches_circomlibjs() {
    assert(hash_1([0]) == 0x2a09a9fd93c590c26b91effbb2499f07e8f7aa12e2b4940a3aed2411cb65e11c);
    assert(hash_2([1, 2]) == 0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a);
}

// Leaves l0, l1, l2: root = H(H(l0, l1), l2), with l2 promoted past the first level.
#[test]
fn three_leaf_tree_by_hand() {
    let (l0, l1, l2) = (hash_1([1]), hash_1([2]), hash_1([3]));
    let n01 = hash_2([l0, l1]);
    let root = hash_2([n01, l2]);
    assert(lean_imt_root(l0, path(0, [l1, l2])) == root);
    assert(lean_imt_root(l1, path(1, [l0, l2])) == root);
    assert(lean_imt_root(l2, path(1, [n01])) == root);
    assert_lean_imt_member(l2, path(1, [n01]), root);
    // A one-leaf tree's root is the leaf.
    assert_lean_imt_member(l0, path(0, []), l0);
}

#[test(should_fail_with = "DepthOutOfRange")]
fn depth_19_is_refused() {
    let _ = lean_imt_root(1, LabelPath { index: 0, depth: 19, siblings: [0; MAX_DEPTH] });
}

#[test(should_fail_with = "IndexOutOfRange")]
fn index_bit_at_depth_is_refused() {
    let _ = lean_imt_root(1, path(4, [5, 6]));
}

#[test(should_fail_with = "SiblingOutOfRange")]
fn sibling_past_depth_is_refused() {
    let mut p = path(0, [5]);
    p.siblings[1] = 1;
    let _ = lean_imt_root(1, p);
}

#[test(should_fail_with = "ZeroRoot")]
fn root_zero_admits_nothing() {
    assert_lean_imt_member(0, path(0, []), 0);
}

#[test(should_fail_with = "NotMember")]
fn wrong_root_is_refused() {
    assert_lean_imt_member(1, path(0, []), 2);
}

// The same inputs and outputs as birth.test.ts in @pp/bridge-spec.
#[test]
fn birth_hashes_match_ts() {
    assert(DOM_SEP__PP_BIRTH_LABEL == 0x70626c31);
    assert(DOM_SEP__PP_BIRTH_NULLIFIER == 0x70626e31);
    assert(DOM_SEP__PP_BIRTH_ID == 0x70626931);
    let token = AztecAddress::from_field(0x7001);
    let owner = AztecAddress::from_field(0x0e01);
    let label = birth_label(token, owner, 1_000_000, 0x5ec0);
    assert(label == 0x1dbf894b632234f02d6cd78fe19f8c444b803861174b337c408a4f7928831d18);
    let nullifier = birth_nullifier(owner, 0x5ec0);
    assert(nullifier == 0x074a84c1a9e6c8067e55ed0f2f9dae9add95e290f670240d3c1948a77097ae36);
    assert(
        compute_siloed_nullifier(token, nullifier)
            == 0x21cb9b4a4aa712a1146e4ae2fcee22c3a026478a38765180970396ab564bbbe9,
    );
    assert(birth_id(label, 0x5ec0) == 0x11bac41f6aee342ca7df5b45f6ee20ac2fca368a1c982b10d818ba4ab586726b);
}
