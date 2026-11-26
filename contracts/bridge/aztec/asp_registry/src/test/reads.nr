use crate::AspRootRegistry::{self, RootRecord};
use crate::label_check::{
    AnchorRoots, birth_intake_at_anchor, fresh_roots, MAX_ROOT_AGE, ORIGIN_BIRTH, ORIGIN_POOL,
    record_at_anchor, SPEND_WINDOW, TreeRoot,
};
use crate::test::utils::{BIRTH_ROOT, current, POOL_ROOT, post_at, post_roots_at, Setup, setup};
use aztec::{
    protocol::address::AztecAddress,
    test::helpers::test_environment::PrivateContextOptions,
    utils::WithHash,
};

unconstrained fn posted_then_anchor(s: Setup, root_time: u64, anchor: u64) {
    post_at(s, s.poster, s.t0, 1, 100, root_time);
    s.env.mine_block_at(anchor);
}

/// Overwrites the stored record (and its hash) directly, as no honest post could.
unconstrained fn forge(s: Setup, record: RootRecord) {
    let slot = AspRootRegistry::storage_layout().current.slot;
    s.env.public_context_at(s.registry, |context| context.storage_write(slot, WithHash::new(record)));
}

#[test]
unconstrained fn read_equals_get_current_at_anchor() {
    let s = setup();
    post_roots_at(s, s.poster, s.t0, 1, 0xa1, 0xb2, 0xc3, s.t0 - 4);
    s.env.mine_block_at(s.t0 + 1);
    let read = s.env.private_context(|context| record_at_anchor(context, s.registry));
    assert_eq(read, current(s));
    assert_eq(read, RootRecord { sequence: 1, pool_root: 0xa1, birth_root: 0xb2, l1_block: 0xc3, root_time: s.t0 - 4 });
}

#[test]
unconstrained fn read_returns_record_at_anchor_not_later() {
    let s = setup();
    post_roots_at(s, s.poster, s.t0, 1, 0xa1, 0xb1, 100, s.t0);
    let first = s.env.last_block_number();
    post_roots_at(s, s.poster, s.t0 + 1, 2, 0xa2, 0xb2, 101, s.t0 + 1);
    s.env.mine_block_at(s.t0 + 2);
    let old = s.env.private_context_opts(
        PrivateContextOptions::new().at_anchor_block_number(first),
        |context| fresh_roots(context, s.registry, ORIGIN_POOL),
    );
    let new = s.env.private_context(|context| fresh_roots(context, s.registry, ORIGIN_POOL));
    assert_eq(old.0, 0xa1);
    assert_eq(new.0, 0xa2);
}

#[test(should_fail_with = "registry unset")]
unconstrained fn fresh_roots_rejects_zero_registry() {
    let s = setup();
    posted_then_anchor(s, s.t0, s.t0 + 1);
    let _ = s.env.private_context(|context| fresh_roots(context, AztecAddress::zero(), ORIGIN_POOL));
}

#[test(should_fail_with = "unknown origin")]
unconstrained fn fresh_roots_rejects_origin_two() {
    let s = setup();
    posted_then_anchor(s, s.t0, s.t0 + 1);
    let _ = s.env.private_context(|context| fresh_roots(context, s.registry, 2));
}

#[test(should_fail_with = "root unset")]
unconstrained fn fresh_roots_rejects_empty_registry() {
    let s = setup();
    let _ = s.env.private_context(|context| fresh_roots(context, s.registry, ORIGIN_POOL));
}

#[test(should_fail_with = "root unset")]
unconstrained fn fresh_roots_rejects_zero_birth_root() {
    let s = setup();
    post_roots_at(s, s.poster, s.t0, 1, POOL_ROOT, 0, 100, s.t0);
    s.env.mine_block_at(s.t0 + 1);
    let _ = s.env.private_context(|context| fresh_roots(context, s.registry, ORIGIN_BIRTH));
}

#[test(should_fail_with = "root unset")]
unconstrained fn fresh_roots_rejects_anchor_after_rotation() {
    let s = setup();
    post_at(s, s.poster, s.t0, 1, 100, s.t0);
    s.env.set_next_block_timestamp(s.t0 + 1);
    s.env.call_public(s.admin, AspRootRegistry::at(s.registry).set_poster(s.admin));
    s.env.mine_block_at(s.t0 + 2);
    let _ = s.env.private_context(|context| fresh_roots(context, s.registry, ORIGIN_POOL));
}

#[test]
unconstrained fn fresh_roots_accepts_age_at_limit() {
    let s = setup();
    let root_time = s.t0 - 10;
    posted_then_anchor(s, root_time, root_time + MAX_ROOT_AGE - SPEND_WINDOW);
    let (root, _) = s.env.private_context(|context| fresh_roots(context, s.registry, ORIGIN_POOL));
    assert_eq(root, POOL_ROOT);
}

#[test(should_fail_with = "root too old")]
unconstrained fn fresh_roots_rejects_age_past_limit() {
    let s = setup();
    let root_time = s.t0 - 10;
    posted_then_anchor(s, root_time, root_time + MAX_ROOT_AGE - SPEND_WINDOW + 1);
    let _ = s.env.private_context(|context| fresh_roots(context, s.registry, ORIGIN_POOL));
}

#[test]
unconstrained fn fresh_roots_accepts_root_time_at_anchor() {
    let s = setup();
    forge(s, RootRecord { sequence: 1, pool_root: POOL_ROOT, birth_root: BIRTH_ROOT, l1_block: 100, root_time: s.t0 + 5 });
    s.env.mine_block_at(s.t0 + 5);
    let (root, _) = s.env.private_context(|context| fresh_roots(context, s.registry, ORIGIN_POOL));
    assert_eq(root, POOL_ROOT);
}

#[test(should_fail_with = "root after anchor")]
unconstrained fn fresh_roots_rejects_root_time_after_anchor() {
    let s = setup();
    forge(s, RootRecord { sequence: 1, pool_root: POOL_ROOT, birth_root: BIRTH_ROOT, l1_block: 100, root_time: s.t0 + 6 });
    s.env.mine_block_at(s.t0 + 5);
    let _ = s.env.private_context(|context| fresh_roots(context, s.registry, ORIGIN_POOL));
}

#[test(should_fail_with = "Hint values do not match hash")]
unconstrained fn fresh_roots_rejects_forged_hint() {
    let s = setup();
    post_at(s, s.poster, s.t0, 1, 100, s.t0);
    // Rewrites `pool_root` alone, leaving the stored hash of the posted record.
    let slot = AspRootRegistry::storage_layout().current.slot;
    s.env.public_context_at(s.registry, |context| context.storage_write(slot + 1, 0xbad));
    s.env.mine_block_at(s.t0 + 1);
    let _ = s.env.private_context(|context| fresh_roots(context, s.registry, ORIGIN_POOL));
}

#[test]
unconstrained fn fresh_roots_returns_both_trees_with_record_time() {
    let s = setup();
    posted_then_anchor(s, s.t0 - 7, s.t0 + 1);
    let (root, roots) = s.env.private_context(|context| fresh_roots(context, s.registry, ORIGIN_BIRTH));
    assert_eq(root, BIRTH_ROOT);
    assert_eq(
        roots,
        AnchorRoots {
            pool: TreeRoot { root: POOL_ROOT, time: s.t0 - 7 },
            birth: TreeRoot { root: BIRTH_ROOT, time: s.t0 - 7 },
        },
    );
}

#[test]
unconstrained fn fresh_roots_sets_expiry_anchor_plus_window() {
    let s = setup();
    posted_then_anchor(s, s.t0, s.t0 + 1);
    let expiry = s.env.private_context(|context| {
        let _ = fresh_roots(context, s.registry, ORIGIN_POOL);
        context.finish().expiration_timestamp
    });
    assert_eq(expiry, s.t0 + 1 + SPEND_WINDOW);
}

#[test]
unconstrained fn fresh_roots_keeps_shorter_caller_expiry() {
    let s = setup();
    posted_then_anchor(s, s.t0, s.t0 + 1);
    let expiry = s.env.private_context(|context| {
        context.set_expiration_timestamp(s.t0 + 100);
        let _ = fresh_roots(context, s.registry, ORIGIN_POOL);
        context.finish().expiration_timestamp
    });
    assert_eq(expiry, s.t0 + 100);
}

#[test]
unconstrained fn birth_intake_at_anchor_returns_anchor_value() {
    let mut s = setup();
    let next = s.env.create_light_account();
    s.env.mine_block_at(s.t0);
    let before = s.env.last_block_number();
    s.env.call_public(s.admin, AspRootRegistry::at(s.registry).set_birth_intake(next));
    s.env.mine_block_at(s.t0 + 1);
    let old = s.env.private_context_opts(
        PrivateContextOptions::new().at_anchor_block_number(before),
        |context| birth_intake_at_anchor(context, s.registry),
    );
    let new = s.env.private_context(|context| birth_intake_at_anchor(context, s.registry));
    assert_eq(old, s.intake);
    assert_eq(new, next);
}

#[test(should_fail_with = "birth intake unset")]
unconstrained fn birth_intake_at_anchor_rejects_unset() {
    let s = setup();
    s.env.call_public(s.admin, AspRootRegistry::at(s.registry).set_birth_intake(AztecAddress::zero()));
    s.env.mine_block_at(s.t0);
    let _ = s.env.private_context(|context| birth_intake_at_anchor(context, s.registry));
}
