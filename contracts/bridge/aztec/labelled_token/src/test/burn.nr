use crate::{
    LabelledToken,
    note::ORIGIN_POOL,
    test::{
        paths::{BIRTH_ROOT, POOL_ROOT, SOLO_ROOT},
        utils::{assert_labels, balance, K, L, mint, post, post_now, ragequit, setup, setup_with_registry, t0, values},
    },
};
use asp_registry::AspRootRegistry;
use aztec::protocol::{address::AztecAddress, traits::FromField};

// A poster change clears both roots; the exit burn reads neither.
#[test]
unconstrained fn burn_for_exit_after_roots_cleared() {
    let s = setup();
    mint(s, s.user, 100, L);
    post_now(s, POOL_ROOT, BIRTH_ROOT);
    s.env.call_public(s.admin, AspRootRegistry::at(s.registry).set_poster(s.admin));
    ragequit(s, s.user, 100, L);
    assert_eq(balance(s, s.user), 0);
}

// A revoked label cannot be consolidated, so nine notes leave in two exact-chunk calls.
#[test]
unconstrained fn burn_for_exit_nine_notes_of_revoked_label_in_two_calls() {
    let s = setup();
    for v in 1..10 {
        mint(s, s.user, v as u128, L);
    }
    let now = t0(s);
    post(s, now, 1, POOL_ROOT, BIRTH_ROOT);
    // Revoked: `L` is in neither tree.
    post(s, now + 1, 2, SOLO_ROOT, SOLO_ROOT);
    s.env.mine_block_at(now + 2);
    ragequit(s, s.user, 44, L);
    ragequit(s, s.user, 1, L);
    assert_eq(balance(s, s.user), 0);
}

#[test]
unconstrained fn burn_for_exit_keeps_label_and_origin_on_change() {
    let s = setup();
    mint(s, s.user, 100, L);
    ragequit(s, s.user, 30, L);
    assert_labels(s, s.user, [(L, ORIGIN_POOL, 70)]);
}

// A dead registry address must not matter: the exit burn never calls it.
#[test]
unconstrained fn burn_for_exit_with_no_registry() {
    let s = setup_with_registry(AztecAddress::from_field(0xdead));
    mint(s, s.user, 100, L);
    ragequit(s, s.user, 100, L);
    assert_eq(balance(s, s.user), 0);
}

#[test(should_fail_with = "Balance too low")]
unconstrained fn burn_for_exit_failure_other_label() {
    let s = setup();
    mint(s, s.user, 100, L);
    ragequit(s, s.user, 10, K);
}

#[test(should_fail_with = "Balance too low")]
unconstrained fn burn_for_exit_failure_over_eight_notes() {
    let s = setup();
    for _ in 0..9 {
        mint(s, s.user, 10, L);
    }
    ragequit(s, s.user, 90, L);
}

// Nine notes need two calls; the view quotes the exact first chunk.
#[test]
unconstrained fn burn_for_exit_nine_notes_in_two_calls() {
    let s = setup();
    for v in 1..10 {
        mint(s, s.user, v as u128, L);
    }
    let page = values(s, s.user, L, 0);
    let mut chunk = 0 as u128;
    for i in 0..8 {
        chunk += page.get(i);
    }
    assert_eq(chunk, 44);
    ragequit(s, s.user, chunk, L);
    ragequit(s, s.user, 1, L);
    assert_eq(balance(s, s.user), 0);
}

#[test(should_fail_with = "caller is not minter")]
unconstrained fn burn_for_exit_failure_not_minter() {
    let s = setup();
    mint(s, s.user, 100, L);
    s.env.call_private(s.user, LabelledToken::at(s.token).burn_for_exit(s.user, 100, L));
}

#[test(should_fail_with = "zero amount")]
unconstrained fn burn_for_exit_failure_zero_amount() {
    let s = setup();
    mint(s, s.user, 100, L);
    ragequit(s, s.user, 0, L);
}
