use crate::{imt::lean_imt_root, PoseidonSpike, vectors::{self, Membership}};
use aztec::{protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment};
use poseidon::poseidon::bn254::{hash_1, hash_2};

unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();
    let caller = env.create_light_account();
    let spike = env.deploy("@poseidon_spike/PoseidonSpike").without_initializer();
    (env, caller, spike)
}

unconstrained fn root_of(m: Membership) -> Field {
    lean_imt_root(hash_1([m.label]), m.depth, m.index, m.siblings)
}

#[test]
fn hash_1_matches_reference() {
    assert_eq(hash_1([vectors::HASH1_0_IN]), vectors::HASH1_0_OUT);
    assert_eq(hash_1([vectors::HASH1_1_IN]), vectors::HASH1_1_OUT);
    assert_eq(hash_1([vectors::HASH1_2_IN]), vectors::HASH1_2_OUT);
    assert_eq(hash_1([vectors::HASH1_3_IN]), vectors::HASH1_3_OUT);
}

#[test]
fn hash_2_matches_reference() {
    assert_eq(hash_2(vectors::HASH2_0_IN), vectors::HASH2_0_OUT);
    assert_eq(hash_2(vectors::HASH2_1_IN), vectors::HASH2_1_OUT);
    assert_eq(hash_2(vectors::HASH2_2_IN), vectors::HASH2_2_OUT);
}

#[test]
unconstrained fn every_membership_path_reproduces_its_root() {
    let all = [
        vectors::SINGLE_LEAF,
        vectors::FIVE_PROMOTED,
        vectors::FIVE_INNER,
        vectors::ELEVEN_PROMOTED,
        vectors::ELEVEN_INNER,
        vectors::DEEP_FIRST,
        vectors::DEEP_PROMOTED,
    ];
    for m in all {
        assert_eq(root_of(m), m.root);
    }
}

#[test]
unconstrained fn contract_computes_pool_commitment_and_asp_leaf() {
    let (env, caller, spike) = setup();
    let commitment = env.call_private(
        caller,
        PoseidonSpike::at(spike).pool_commitment(vectors::POOL_PRECOMMITMENT, vectors::POOL_LABEL),
    );
    assert_eq(commitment, vectors::POOL_COMMITMENT);
    assert_eq(
        env.call_private(caller, PoseidonSpike::at(spike).asp_leaf(vectors::POOL_LABEL)),
        vectors::POOL_ASP_LEAF,
    );
}

#[test]
unconstrained fn contract_accepts_depth_18_member() {
    let (env, caller, spike) = setup();
    let m = vectors::DEEP_FIRST;
    env.call_private(
        caller,
        PoseidonSpike::at(spike).asp_member(m.label, m.root, m.depth, m.index, m.siblings),
    );
}

#[test]
unconstrained fn contract_accepts_promoted_leaf() {
    let (env, caller, spike) = setup();
    let m = vectors::DEEP_PROMOTED;
    env.call_private(
        caller,
        PoseidonSpike::at(spike).asp_member(m.label, m.root, m.depth, m.index, m.siblings),
    );
}

#[test(should_fail_with = "label not in root")]
unconstrained fn asp_member_failure_wrong_sibling() {
    let (env, caller, spike) = setup();
    let m = vectors::DEEP_FIRST;
    let mut siblings = m.siblings;
    siblings[5] += 1;
    env.call_private(
        caller,
        PoseidonSpike::at(spike).asp_member(m.label, m.root, m.depth, m.index, siblings),
    );
}

#[test(should_fail_with = "label not in root")]
unconstrained fn asp_member_failure_wrong_index_bit() {
    let (env, caller, spike) = setup();
    let m = vectors::FIVE_INNER;
    env.call_private(
        caller,
        PoseidonSpike::at(spike).asp_member(m.label, m.root, m.depth, m.index ^ 1, m.siblings),
    );
}

#[test(should_fail_with = "label not in root")]
unconstrained fn asp_member_failure_wrong_depth() {
    let (env, caller, spike) = setup();
    let m = vectors::FIVE_INNER;
    env.call_private(
        caller,
        PoseidonSpike::at(spike).asp_member(m.label, m.root, m.depth - 1, m.index, m.siblings),
    );
}

#[test(should_fail_with = "index bits above depth")]
unconstrained fn asp_member_failure_index_bit_above_depth() {
    let (env, caller, spike) = setup();
    let m = vectors::FIVE_PROMOTED;
    env.call_private(
        caller,
        PoseidonSpike::at(spike).asp_member(m.label, m.root, m.depth, m.index | 2, m.siblings),
    );
}

#[test(should_fail_with = "depth above 18")]
unconstrained fn asp_member_failure_depth_above_18_against_zero_root() {
    let (env, caller, spike) = setup();
    let m = vectors::DEEP_FIRST;
    env.call_private(
        caller,
        PoseidonSpike::at(spike).asp_member(m.label, 0, 19, m.index, m.siblings),
    );
}
