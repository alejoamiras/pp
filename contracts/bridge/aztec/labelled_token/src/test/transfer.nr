use crate::{
    note::ORIGIN_POOL,
    test::{
        paths::{BIRTH_PATHS, BIRTH_ROOT, POOL_PATHS, POOL_ROOT, SOLO_ROOT},
        utils::{assert_labels, K, L, mint, post_now, setup, transfer},
    },
};
use aztec::protocol::{address::AztecAddress, traits::FromField};

#[test]
unconstrained fn transfer_private_moves_label_and_origin() {
    let s = setup();
    mint(s, s.user, 50, L);
    post_now(s, POOL_ROOT, BIRTH_ROOT);
    transfer(s, s.user, s.admin, 20, L, POOL_PATHS[0]);
    assert_labels(s, s.user, [(L, ORIGIN_POOL, 30)]);
    assert_labels(s, s.admin, [(L, ORIGIN_POOL, 20)]);
}

#[test]
unconstrained fn transfer_private_exact_spend_has_no_change() {
    let s = setup();
    mint(s, s.user, 50, L);
    post_now(s, POOL_ROOT, BIRTH_ROOT);
    transfer(s, s.user, s.admin, 50, L, POOL_PATHS[0]);
    let none: [(Field, u8, u128); 0] = [];
    assert_labels(s, s.user, none);
    assert_labels(s, s.admin, [(L, ORIGIN_POOL, 50)]);
}

// The spend selects only `label`'s notes, so another label's balance never pays for it.
#[test(should_fail_with = "Balance too low")]
unconstrained fn transfer_private_failure_other_label_notes() {
    let s = setup();
    mint(s, s.user, 50, K);
    post_now(s, POOL_ROOT, BIRTH_ROOT);
    transfer(s, s.user, s.admin, 20, L, POOL_PATHS[0]);
}

#[test(should_fail_with = "NotMember")]
unconstrained fn transfer_private_failure_pool_note_birth_path() {
    let s = setup();
    mint(s, s.user, 50, L);
    post_now(s, POOL_ROOT, BIRTH_ROOT);
    transfer(s, s.user, s.admin, 20, L, BIRTH_PATHS[1]);
}

#[test(should_fail_with = "NotMember")]
unconstrained fn transfer_private_failure_label_not_in_root() {
    let s = setup();
    mint(s, s.user, 50, L);
    post_now(s, SOLO_ROOT, BIRTH_ROOT);
    transfer(s, s.user, s.admin, 20, L, POOL_PATHS[0]);
}

#[test(should_fail_with = "Balance too low")]
unconstrained fn transfer_private_failure_over_eight_notes() {
    let s = setup();
    for _ in 0..9 {
        mint(s, s.user, 10, L);
    }
    post_now(s, POOL_ROOT, BIRTH_ROOT);
    transfer(s, s.user, s.admin, 90, L, POOL_PATHS[0]);
}

#[test(should_fail_with = "zero amount")]
unconstrained fn transfer_private_failure_zero_amount() {
    let s = setup();
    mint(s, s.user, 50, L);
    post_now(s, POOL_ROOT, BIRTH_ROOT);
    transfer(s, s.user, s.admin, 0, L, POOL_PATHS[0]);
}

#[test(should_fail_with = "zero recipient")]
unconstrained fn transfer_private_failure_zero_recipient() {
    let s = setup();
    mint(s, s.user, 50, L);
    post_now(s, POOL_ROOT, BIRTH_ROOT);
    transfer(s, s.user, AztecAddress::zero(), 20, L, POOL_PATHS[0]);
}

// x = 3 is off the curve: 3^3 - 17 is a non-residue.
#[test(should_fail_with = "invalid recipient")]
unconstrained fn transfer_private_failure_invalid_recipient() {
    let s = setup();
    mint(s, s.user, 50, L);
    post_now(s, POOL_ROOT, BIRTH_ROOT);
    transfer(s, s.user, AztecAddress::from_field(3), 20, L, POOL_PATHS[0]);
}
