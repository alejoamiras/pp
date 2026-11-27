use crate::{
    LabelledToken,
    note::ORIGIN_POOL,
    test::{
        paths::{BIRTH_ROOT, POOL_PATHS, POOL_ROOT, SOLO_ROOT},
        utils::{assert_labels, L, mint, post_now, public_balance, setup, Setup, unshield},
    },
};
use asp_registry::label_check::{AnchorRoots, TreeRoot};
use aztec::protocol::{address::AztecAddress, traits::FromField};
use bridge_stub::BridgeStub;

global SENTINEL: Field = 0x1ea7e01501975545617c2e694d931cb576b691a4a867fed81ebd3264;

/// `user` holds 20 publicly and `(L, POOL, 30)` privately.
unconstrained fn unshielded() -> Setup {
    let s = setup();
    mint(s, s.user, 50, L);
    post_now(s, POOL_ROOT, BIRTH_ROOT);
    unshield(s, s.user, 20, L, POOL_PATHS[0]);
    s
}

unconstrained fn transfer_public(s: Setup, to: AztecAddress, amount: u128) {
    s.env.call_public(s.user, LabelledToken::at(s.token).transfer_public(to, amount));
}

#[test]
unconstrained fn unshield_credits_owner_and_keeps_change_label() {
    let s = unshielded();
    assert_eq(public_balance(s, s.user), 20);
    assert_labels(s, s.user, [(L, ORIGIN_POOL, 30)]);
}

#[test(should_fail_with = "NotMember")]
unconstrained fn unshield_failure_label_not_in_root() {
    let s = setup();
    mint(s, s.user, 50, L);
    post_now(s, SOLO_ROOT, BIRTH_ROOT);
    unshield(s, s.user, 20, L, POOL_PATHS[0]);
}

// The credit is the token's own step, so nobody can mint public balance by calling it.
#[test(should_fail_with = "Function finish_unshield can only be called by the same contract")]
unconstrained fn finish_unshield_failure_not_self() {
    let s = setup();
    post_now(s, POOL_ROOT, BIRTH_ROOT);
    let roots = AnchorRoots { pool: TreeRoot { root: POOL_ROOT, time: 0 }, birth: TreeRoot { root: BIRTH_ROOT, time: 0 } };
    s.env.call_public(s.user, LabelledToken::at(s.token).finish_unshield(s.user, 20, roots));
}

#[test]
unconstrained fn transfer_public_moves() {
    let s = unshielded();
    transfer_public(s, s.admin, 15);
    assert_eq(public_balance(s, s.user), 5);
    assert_eq(public_balance(s, s.admin), 15);
}

#[test(should_fail_with = "Balance too low")]
unconstrained fn transfer_public_failure_overdraw() {
    let s = unshielded();
    transfer_public(s, s.admin, 21);
}

#[test(should_fail_with = "zero recipient")]
unconstrained fn transfer_public_failure_zero_recipient() {
    let s = unshielded();
    transfer_public(s, AztecAddress::zero(), 5);
}

#[test(should_fail_with = "zero amount")]
unconstrained fn transfer_public_failure_zero_amount() {
    let s = unshielded();
    transfer_public(s, s.admin, 0);
}

#[test(should_fail_with = "private sentinel recipient")]
unconstrained fn transfer_public_failure_private_sentinel() {
    let s = unshielded();
    transfer_public(s, AztecAddress::from_field(SENTINEL), 5);
}

// x = 3 is off the curve: 3^3 - 17 is a non-residue.
#[test(should_fail_with = "invalid recipient")]
unconstrained fn transfer_public_failure_invalid_recipient() {
    let s = unshielded();
    transfer_public(s, AztecAddress::from_field(3), 5);
}

#[test]
unconstrained fn burn_public_for_exit_burns() {
    let s = unshielded();
    s.env.call_public(s.user, BridgeStub::at(s.stub).ragequit_public(s.token, 20));
    assert_eq(public_balance(s, s.user), 0);
}

#[test(should_fail_with = "caller is not minter")]
unconstrained fn burn_public_for_exit_failure_not_minter() {
    let s = unshielded();
    s.env.call_public(s.user, LabelledToken::at(s.token).burn_public_for_exit(s.user, 20));
}
