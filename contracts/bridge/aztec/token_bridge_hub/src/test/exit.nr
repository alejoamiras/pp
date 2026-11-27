// As in `ragequit.nr`, each refusal holds 10 publicly and asks 11 (the zero-amount case asks 0), so a
// hub that burned first would fail with the token's message (`Balance too low` or `zero amount`)
// rather than the expected pre-burn one.

use crate::test::utils::{deposit, fund, Hub, PORTAL_A, post_pool_root, register_a, setup_with_asp};
use crate::TokenBridgeHub;
use aztec::{
    ephemeral::EphemeralArray,
    event::{event_interface::EventInterface, EventSelector},
    oracle::message_processing::get_tx_effects,
    protocol::{
        address::{AztecAddress, EthAddress}, constants::DOM_SEP__EVENT_LOG_TAG,
        hash::compute_log_tag, traits::{Deserialize, FromField, ToField},
    },
    test::helpers::txe_oracles::get_last_tx_effects,
};
use labelled_token::LabelledToken;
use pp_hash::{hash_1, LabelPath};

global PAYEE: EthAddress = EthAddress::from_field(0xbeef);

/// A registered token and an account holding 10 of it publicly and nothing privately: the claim's
/// label is the registry's only pool label, so its depth-0 path is the empty one.
unconstrained fn public_holder() -> (Hub, AztecAddress, AztecAddress) {
    let mut h = setup_with_asp();
    let user = h.env.create_light_account();
    let token = register_a(h);
    let mut d = deposit();
    d.amount = 10;
    fund(h, token, PORTAL_A, user, d);
    post_pool_root(h, hash_1([d.label]));
    let path = LabelPath { index: 0, depth: 0, siblings: [0; 18] };
    h.env.call_private(user, LabelledToken::at(token).unshield(10, d.label, path));
    assert_eq(public_balance(h, token, user), 10);
    (h, user, token)
}

unconstrained fn exit_public(h: Hub, from: AztecAddress, token: AztecAddress, payee: EthAddress, amount: u128) {
    h.env.call_public(from, TokenBridgeHub::at(h.hub).exit_public(token, payee, amount));
}

unconstrained fn public_balance(h: Hub, token: AztecAddress, owner: AztecAddress) -> u128 {
    h.env.view_public(LabelledToken::at(token).balance_of_public(owner))
}

#[test]
unconstrained fn exit_public_burns_exactly() {
    let (h, user, token) = public_holder();
    exit_public(h, user, token, PAYEE, 4);
    assert_eq(public_balance(h, token, user), 6);
}

// Exactly two public logs: the token's burn of the caller's amount, then the hub's ticket with the
// token, the payee and that amount.
#[test]
unconstrained fn exit_public_ticket_matches_the_burn() {
    let (h, user, token) = public_holder();
    exit_public(h, user, token, PAYEE, 4);
    let tx_hash = get_last_tx_effects().tx_hash;
    let effect = h.env.utility_context(|_| get_tx_effects(EphemeralArray::from_array([tx_hash])).get(0)).unwrap();
    assert_eq(effect.revert_code, 0);

    // `LabelledToken`'s `Transfer` is not public, so its type id is rebuilt from its signature.
    let burn_tag = compute_log_tag(
        EventSelector::from_signature("Transfer((Field),(Field),u128)").to_field(),
        DOM_SEP__EVENT_LOG_TAG,
    );
    let ticket_tag = compute_log_tag(
        TokenBridgeHub::PublicExitTicket::get_event_type_id().to_field(),
        DOM_SEP__EVENT_LOG_TAG,
    );
    let expected = [
        4, token.to_field(), burn_tag, user.to_field(), 0, 4,
        4, h.hub.to_field(), ticket_tag, token.to_field(), PAYEE.to_field(), 4,
    ];
    let logs = effect.public_logs;
    assert_eq(logs.length, 12);
    for i in 0..12 {
        assert_eq(logs.payload[i], expected[i]);
    }
}

#[test(should_fail_with = "AmountOutOfRange")]
unconstrained fn exit_public_failure_zero_amount() {
    let (h, user, token) = public_holder();
    exit_public(h, user, token, PAYEE, 0);
}

#[test(should_fail_with = "ZeroPayee")]
unconstrained fn exit_public_failure_zero_payee() {
    let (h, user, token) = public_holder();
    exit_public(h, user, token, EthAddress::zero(), 11);
}

#[test(should_fail_with = "exit payee is the portal")]
unconstrained fn exit_public_failure_portal_payee() {
    let (h, user, token) = public_holder();
    exit_public(h, user, token, PORTAL_A, 11);
}

// `EthAddress::from_field` range-checks; deserializing keeps the raw word, as a raw L2 caller's does.
#[test(should_fail_with = "PayeeOutOfRange")]
unconstrained fn exit_public_failure_wide_payee() {
    let (h, user, token) = public_holder();
    let wide = EthAddress::deserialize([0x10000000000000000000000000000000000000000]);
    exit_public(h, user, token, wide, 11);
}

#[test(should_fail_with = "Trying to read from uninitialized PublicImmutable")]
unconstrained fn exit_public_failure_unregistered_token() {
    let (h, user, _) = public_holder();
    exit_public(h, user, AztecAddress::from_field(0xDEAD), PAYEE, 11);
}

#[test(should_fail_with = "Balance too low")]
unconstrained fn exit_public_failure_over_balance() {
    let (h, user, token) = public_holder();
    exit_public(h, user, token, PAYEE, 11);
}
