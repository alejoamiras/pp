use crate::LabelToken;
use aztec::{
    protocol::address::AztecAddress,
    test::helpers::test_environment::{ExecuteUtilityOptions, TestEnvironment},
};

global L1: Field = 0x111;
global L2: Field = 0x222;

unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();
    let minter = env.create_light_account();
    let bob = env.create_light_account();
    let token = env.deploy("@label_token/LabelToken").with_public_initializer(
        minter,
        LabelToken::interface().constructor(minter),
    );
    (env, token, minter, bob)
}

/// A top-level read scoped to `owner`: the owner's own discovery, not an injected note.
unconstrained fn balance(
    env: TestEnvironment,
    token: AztecAddress,
    owner: AztecAddress,
    label: Field,
) -> u128 {
    env.execute_utility_opts(
        ExecuteUtilityOptions::new().with_from(owner),
        LabelToken::at(token).balance_of(owner, label),
    )
}

#[test]
unconstrained fn mint_then_owner_scoped_read_sees_the_note() {
    let (env, token, minter, bob) = setup();
    env.call_private(minter, LabelToken::at(token).mint_private(bob, L1, 100));
    assert_eq(balance(env, token, bob, L1), 100);
}

#[test]
unconstrained fn labels_stay_apart() {
    let (env, token, minter, bob) = setup();
    env.call_private(minter, LabelToken::at(token).mint_private(bob, L1, 100));
    env.call_private(minter, LabelToken::at(token).mint_private(bob, L2, 7));
    assert_eq(balance(env, token, bob, L1), 100);
    assert_eq(balance(env, token, bob, L2), 7);
    assert_eq(balance(env, token, bob, 0x333), 0);
}

#[test]
unconstrained fn spend_selects_only_its_label() {
    let (mut env, token, minter, bob) = setup();
    let carol = env.create_light_account();
    env.call_private(minter, LabelToken::at(token).mint_private(bob, L1, 100));
    env.call_private(minter, LabelToken::at(token).mint_private(bob, L2, 50));

    env.call_private(bob, LabelToken::at(token).transfer_private(carol, L1, 30));

    assert_eq(balance(env, token, bob, L1), 70);
    assert_eq(balance(env, token, bob, L2), 50);
    assert_eq(balance(env, token, carol, L1), 30);
    assert_eq(balance(env, token, carol, L2), 0);
}

#[test(should_fail_with = "balance too low for label")]
unconstrained fn transfer_failure_other_label_cannot_cover() {
    let (mut env, token, minter, bob) = setup();
    let carol = env.create_light_account();
    env.call_private(minter, LabelToken::at(token).mint_private(bob, L1, 10));
    env.call_private(minter, LabelToken::at(token).mint_private(bob, L2, 1000));
    env.call_private(bob, LabelToken::at(token).transfer_private(carol, L1, 11));
}

#[test(should_fail_with = "caller is not the minter")]
unconstrained fn mint_failure_not_minter() {
    let (env, token, _minter, bob) = setup();
    env.call_private(bob, LabelToken::at(token).mint_private(bob, L1, 1));
}
