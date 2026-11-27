use crate::{
    LabelledToken,
    note::ORIGIN_POOL,
    test::utils::{assert_labels, balance, L, mint, setup},
};
use aztec::protocol::{address::AztecAddress, traits::FromField};

#[test]
unconstrained fn mint_from_bridge_credits_label_and_origin() {
    let s = setup();
    mint(s, s.user, 100, L);
    assert_labels(s, s.user, [(L, ORIGIN_POOL, 100)]);
    assert_eq(balance(s, s.user), 100);
}

#[test(should_fail_with = "caller is not minter")]
unconstrained fn mint_from_bridge_failure_not_minter() {
    let s = setup();
    s.env.call_private(s.user, LabelledToken::at(s.token).mint_from_bridge(s.user, 100, L));
}

#[test(should_fail_with = "zero amount")]
unconstrained fn mint_from_bridge_failure_zero_amount() {
    let s = setup();
    mint(s, s.user, 0, L);
}

#[test(should_fail_with = "zero label")]
unconstrained fn mint_from_bridge_failure_zero_label() {
    let s = setup();
    mint(s, s.user, 100, 0);
}

// x = 3 is off the curve: 3^3 - 17 is a non-residue.
#[test(should_fail_with = "invalid recipient")]
unconstrained fn mint_from_bridge_failure_invalid_recipient() {
    let s = setup();
    mint(s, AztecAddress::from_field(3), 100, L);
}
