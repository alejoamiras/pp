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

#[test]
unconstrained fn completed_partial_carries_its_label_and_spends_under_it() {
    let (mut env, token, minter, bob) = setup();
    let carol = env.create_light_account();
    env.call_public(minter, LabelToken::at(token).mint_public(minter, 100));
    let commitment = env.call_private(bob, LabelToken::at(token).prepare_partial(bob, L1, minter));
    env.call_public(minter, LabelToken::at(token).complete_partial(commitment, 40));

    assert_eq(env.view_public(LabelToken::at(token).balance_of_public(minter)), 60);
    assert_eq(balance(env, token, bob, L1), 40);
    assert_eq(balance(env, token, bob, L2), 0);
    env.call_private(bob, LabelToken::at(token).transfer_private(carol, L1, 40));
    assert_eq(balance(env, token, carol, L1), 40);
}

#[test]
unconstrained fn third_party_prepares_for_the_owner() {
    let (mut env, token, minter, bob) = setup();
    let carol = env.create_light_account();
    env.call_public(minter, LabelToken::at(token).mint_public(minter, 100));
    let commitment =
        env.call_private(carol, LabelToken::at(token).prepare_partial(bob, L1, minter));
    env.call_public(minter, LabelToken::at(token).complete_partial(commitment, 25));
    assert_eq(balance(env, token, bob, L1), 25);
}

// The revert undoes the second debit and the second note hash with the rest of the public call.
#[test(should_fail_with = "Attempted to emit duplicate nullifier")]
unconstrained fn complete_failure_second_completion() {
    let (env, token, minter, bob) = setup();
    env.call_public(minter, LabelToken::at(token).mint_public(minter, 100));
    let commitment = env.call_private(bob, LabelToken::at(token).prepare_partial(bob, L1, minter));
    env.call_public(minter, LabelToken::at(token).complete_partial(commitment, 10));
    env.call_public(minter, LabelToken::at(token).complete_partial(commitment, 10));
}

#[test(should_fail_with = "zero completion")]
unconstrained fn complete_failure_zero_amount() {
    let (env, token, minter, bob) = setup();
    let commitment = env.call_private(bob, LabelToken::at(token).prepare_partial(bob, L1, minter));
    env.call_public(minter, LabelToken::at(token).complete_partial(commitment, 0));
}

#[test(should_fail_with = "invalid partial note or completer")]
unconstrained fn complete_failure_wrong_completer() {
    let (mut env, token, minter, bob) = setup();
    let carol = env.create_light_account();
    env.call_public(minter, LabelToken::at(token).mint_public(carol, 100));
    let commitment = env.call_private(bob, LabelToken::at(token).prepare_partial(bob, L1, minter));
    env.call_public(carol, LabelToken::at(token).complete_partial(commitment, 10));
}

#[test]
unconstrained fn shield_debits_the_shielder() {
    let (env, token, minter, bob) = setup();
    env.call_public(minter, LabelToken::at(token).mint_public(bob, 50));
    env.call_private(bob, LabelToken::at(token).shield(L1, 20));
    assert_eq(env.view_public(LabelToken::at(token).balance_of_public(bob)), 30);
    assert_eq(balance(env, token, bob, L1), 20);
}

#[test(should_fail_with = "caller is not the minter")]
unconstrained fn mint_failure_not_minter() {
    let (env, token, _minter, bob) = setup();
    env.call_private(bob, LabelToken::at(token).mint_private(bob, L1, 1));
}
