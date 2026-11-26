// Every argument of `claim_from_pool` reaches the consumed content or its secret, so a claim that
// changes any one of them finds no message.

use crate::test::utils::{
    claim, deposit, PORTAL_A, register, register_a, send_bridge_message, setup,
    ERC20_B, NAME_B, PORTAL_B, SYMBOL_B, DECIMALS,
};
use aztec::protocol::{address::AztecAddress, traits::FromField};
use labelled_token::{LabelledToken, note::ORIGIN_POOL};
use pp_hash::hash_2;

#[test]
unconstrained fn claim_from_pool_mints_under_the_label() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let a = register_a(h);
    let d = deposit();
    let leaf = send_bridge_message(h, PORTAL_A, user, d);
    claim(h, user, a, d, leaf);
    let labels = h.env.execute_utility(LabelledToken::at(a).private_balances_by_label(user, 0));
    assert_eq(labels.len(), 1);
    assert_eq(labels.get(0), (d.label, ORIGIN_POOL, d.amount));
    assert_eq(h.env.execute_utility(LabelledToken::at(a).balance_of_private(user)), d.amount);
}

#[test(should_fail_with = "No L1 to L2 message found")]
unconstrained fn claim_from_pool_failure_wrong_label() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let a = register_a(h);
    let mut d = deposit();
    let leaf = send_bridge_message(h, PORTAL_A, user, d);
    d.label += 1;
    claim(h, user, a, d, leaf);
}

// Passing the on-chain commitment itself as the precommitment hashes it a second time.
#[test(should_fail_with = "No L1 to L2 message found")]
unconstrained fn claim_from_pool_failure_wrong_precommitment() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let a = register_a(h);
    let mut d = deposit();
    let leaf = send_bridge_message(h, PORTAL_A, user, d);
    d.change_precommitment = hash_2([d.change_precommitment, d.label]);
    claim(h, user, a, d, leaf);
}

#[test(should_fail_with = "No L1 to L2 message found")]
unconstrained fn claim_from_pool_failure_wrong_amount() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let a = register_a(h);
    let mut d = deposit();
    let leaf = send_bridge_message(h, PORTAL_A, user, d);
    d.amount += 1;
    claim(h, user, a, d, leaf);
}

#[test(should_fail_with = "No L1 to L2 message found")]
unconstrained fn claim_from_pool_failure_wrong_nullifier() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let a = register_a(h);
    let mut d = deposit();
    let leaf = send_bridge_message(h, PORTAL_A, user, d);
    d.nullifier += 1;
    claim(h, user, a, d, leaf);
}

#[test(should_fail_with = "No L1 to L2 message found")]
unconstrained fn claim_from_pool_failure_wrong_salt() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let a = register_a(h);
    let mut d = deposit();
    let leaf = send_bridge_message(h, PORTAL_A, user, d);
    d.claim_salt += 1;
    claim(h, user, a, d, leaf);
}

// The leaf of another deposit to the same account: each message is consumable only at its own leaf.
#[test(should_fail_with = "No L1 to L2 message found")]
unconstrained fn claim_from_pool_failure_wrong_leaf_index() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let a = register_a(h);
    let d = deposit();
    let mut other = deposit();
    other.nullifier += 1;
    let _ = send_bridge_message(h, PORTAL_A, user, d);
    let other_leaf = send_bridge_message(h, PORTAL_A, user, other);
    claim(h, user, a, d, other_leaf);
}

// The portal is read from the claimed token, so a deposit through portal A cannot mint token B.
#[test(should_fail_with = "No L1 to L2 message found")]
unconstrained fn claim_from_pool_failure_wrong_token() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let _a = register_a(h);
    let b = register(h, ERC20_B, PORTAL_B, NAME_B, SYMBOL_B, DECIMALS);
    let d = deposit();
    let leaf = send_bridge_message(h, PORTAL_A, user, d);
    claim(h, user, b, d, leaf);
}

// Someone holding every argument of another account's deposit derives another secret.
#[test(should_fail_with = "No L1 to L2 message found")]
unconstrained fn claim_from_pool_failure_other_account() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let thief = h.env.create_light_account();
    let a = register_a(h);
    let d = deposit();
    let leaf = send_bridge_message(h, PORTAL_A, user, d);
    claim(h, thief, a, d, leaf);
}

#[test(should_fail_with = "No non-nullified L1 to L2 message found")]
unconstrained fn claim_from_pool_failure_replay() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let a = register_a(h);
    let d = deposit();
    let leaf = send_bridge_message(h, PORTAL_A, user, d);
    claim(h, user, a, d, leaf);
    claim(h, user, a, d, leaf);
}

#[test(should_fail_with = "Trying to read from uninitialized PublicImmutable")]
unconstrained fn claim_from_pool_failure_unregistered_token() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let d = deposit();
    let leaf = send_bridge_message(h, PORTAL_A, user, d);
    claim(h, user, AztecAddress::from_field(0xDEAD), d, leaf);
}

#[test(should_fail_with = "AmountOutOfRange")]
unconstrained fn claim_from_pool_failure_zero_amount() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let a = register_a(h);
    let mut d = deposit();
    d.amount = 0;
    claim(h, user, a, d, 0);
}

// The hub's own refusal, before any read: no encoder checks an inbound claim's label.
#[test(should_fail_with = "claim label is zero")]
unconstrained fn claim_from_pool_failure_zero_label() {
    let mut h = setup();
    let user = h.env.create_light_account();
    let a = register_a(h);
    let mut d = deposit();
    d.label = 0;
    claim(h, user, a, d, 0);
}
