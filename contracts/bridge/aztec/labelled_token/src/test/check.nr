// The token's wiring of `check_label`, driven through `transfer_private`; the library's own cases
// are the registry crate's.
use crate::test::{
    paths::{
        BIRTH_PATHS, BIRTH_ROOT, DEEP_LABELS, DEEP_PATHS, DEEP_ROOT, POOL_LABELS, POOL_PATHS, POOL_ROOT,
        SOLO_LABELS, SOLO_PATHS, SOLO_ROOT,
    },
    utils::{L, mint, post, post_now, setup, setup_with_registry, t0, transfer},
};
use asp_registry::{AspRootRegistry, label_check::LabelPath};
use aztec::protocol::address::AztecAddress;

#[test]
unconstrained fn check_accepts_depths_0_and_18_and_promoted_leaf() {
    let s = setup();
    let cases = [
        (SOLO_ROOT, SOLO_LABELS[0], SOLO_PATHS[0]),
        (DEEP_ROOT, DEEP_LABELS[0], DEEP_PATHS[0]),
        (POOL_ROOT, POOL_LABELS[4], POOL_PATHS[4]),
    ];
    let now = t0(s);
    for i in 0..cases.len() {
        let (root, label, path) = cases[i];
        mint(s, s.user, 10, label);
        let at = now + 10 * (i as u64);
        post(s, at, 1 + (i as u64), root, BIRTH_ROOT);
        s.env.mine_block_at(at + 1);
        transfer(s, s.user, s.admin, 10, label, path);
    }
}

#[test(should_fail_with = "NotMember")]
unconstrained fn check_failure_wrong_sibling() {
    let s = setup();
    mint(s, s.user, 50, L);
    post_now(s, POOL_ROOT, BIRTH_ROOT);
    let mut path = POOL_PATHS[0];
    path.siblings[0] += 1;
    transfer(s, s.user, s.admin, 20, L, path);
}

#[test(should_fail_with = "NotMember")]
unconstrained fn check_failure_other_label_path() {
    let s = setup();
    mint(s, s.user, 50, L);
    post_now(s, POOL_ROOT, BIRTH_ROOT);
    transfer(s, s.user, s.admin, 20, L, POOL_PATHS[1]);
}

#[test(should_fail_with = "IndexOutOfRange")]
unconstrained fn check_failure_index_bit_above_depth() {
    let s = setup();
    mint(s, s.user, 50, L);
    post_now(s, POOL_ROOT, BIRTH_ROOT);
    let path = POOL_PATHS[0];
    transfer(s, s.user, s.admin, 20, L, LabelPath { index: path.index | 8, depth: path.depth, siblings: path.siblings });
}

#[test(should_fail_with = "DepthOutOfRange")]
unconstrained fn check_failure_depth_above_18() {
    let s = setup();
    mint(s, s.user, 50, L);
    post_now(s, POOL_ROOT, BIRTH_ROOT);
    let path = POOL_PATHS[0];
    transfer(s, s.user, s.admin, 20, L, LabelPath { index: path.index, depth: 19, siblings: path.siblings });
}

#[test(should_fail_with = "root unset")]
unconstrained fn check_failure_empty_registry() {
    let s = setup();
    mint(s, s.user, 50, L);
    transfer(s, s.user, s.admin, 20, L, POOL_PATHS[0]);
}

#[test(should_fail_with = "registry unset")]
unconstrained fn check_failure_unset_registry_address() {
    let s = setup_with_registry(AztecAddress::zero());
    mint(s, s.user, 50, L);
    transfer(s, s.user, s.admin, 20, L, POOL_PATHS[0]);
}

// The registry comes from the token's config, so a second registry that admits L admits nothing here.
#[test(should_fail_with = "NotMember")]
unconstrained fn check_failure_label_only_in_other_registry() {
    let mut s = setup();
    let other = s.env.deploy("@asp_registry/AspRootRegistry").with_public_initializer(
        s.admin,
        AspRootRegistry::interface().constructor(s.admin, s.poster, s.admin),
    );
    mint(s, s.user, 50, L);
    let now = t0(s);
    s.env.set_next_block_timestamp(now);
    s.env.call_public(s.poster, AspRootRegistry::at(other).post_root(1, POOL_ROOT, BIRTH_ROOT, 101, now, 1, 1));
    post(s, now + 1, 1, SOLO_ROOT, BIRTH_ROOT);
    s.env.mine_block_at(now + 2);
    transfer(s, s.user, s.admin, 20, L, POOL_PATHS[0]);
}

// A record serves an anchor up to `root_time + 1800`, so its spends still land by `root_time + 3600`.
#[test]
unconstrained fn check_freshness_passes_at_equality() {
    let s = setup();
    mint(s, s.user, 50, L);
    let now = t0(s);
    post(s, now, 1, POOL_ROOT, BIRTH_ROOT);
    s.env.mine_block_at(now + 1800);
    transfer(s, s.user, s.admin, 20, L, POOL_PATHS[0]);
}

#[test(should_fail_with = "root too old")]
unconstrained fn check_failure_stale_root_by_one_second() {
    let s = setup();
    mint(s, s.user, 50, L);
    let now = t0(s);
    post(s, now, 1, POOL_ROOT, BIRTH_ROOT);
    s.env.mine_block_at(now + 1801);
    transfer(s, s.user, s.admin, 20, L, POOL_PATHS[0]);
}

// A pool label the bot has moved into the birth tree admits nothing: the notes' origin picks the tree.
#[test(should_fail_with = "NotMember")]
unconstrained fn check_failure_pool_label_in_birth_root() {
    let s = setup();
    mint(s, s.user, 50, L);
    post_now(s, SOLO_ROOT, BIRTH_ROOT);
    transfer(s, s.user, s.admin, 20, L, BIRTH_PATHS[1]);
}
