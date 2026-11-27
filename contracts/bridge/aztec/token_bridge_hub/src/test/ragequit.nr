// A failed private TXE call ends the test, so a balance cannot be read after a refusal. Instead each
// refusal holds 10 and asks 11 (the zero-amount case asks 0): a hub that burned first would fail
// with the token's own message (`Balance too low`, as `ragequit_failure_over_balance` shows, or
// `zero amount`), not with the expected pre-burn one.

use crate::test::utils::{deposit, Deposit, fund, Hub, label_balance, PORTAL_A, register_a, setup};
use crate::TokenBridgeHub;
use aztec::{
    ephemeral::EphemeralArray,
    event::event_interface::EventInterface,
    oracle::message_processing::get_tx_effects,
    protocol::{
        address::{AztecAddress, EthAddress}, constants::DOM_SEP__EVENT_LOG_TAG,
        hash::compute_log_tag, traits::{Deserialize, FromField, ToField},
    },
    test::helpers::txe_oracles::get_last_tx_effects,
};

global PAYEE: EthAddress = EthAddress::from_field(0xbeef);
global K: Field = 0x2abe1;

/// A registered token and an account holding 10 of `deposit().label`.
unconstrained fn holder() -> (Hub, AztecAddress, AztecAddress, Field) {
    let mut h = setup();
    let user = h.env.create_light_account();
    let token = register_a(h);
    let mut d = deposit();
    d.amount = 10;
    fund(h, token, PORTAL_A, user, d);
    (h, user, token, d.label)
}

unconstrained fn ragequit(
    h: Hub,
    from: AztecAddress,
    token: AztecAddress,
    payee: EthAddress,
    amount: u128,
    label: Field,
) {
    h.env.call_private(from, TokenBridgeHub::at(h.hub).ragequit(token, payee, amount, label));
}

#[test]
unconstrained fn ragequit_burns_exactly_with_no_registry() {
    let (h, user, token, label) = holder();
    ragequit(h, user, token, PAYEE, 4, label);
    assert_eq(label_balance(h, token, user, label), 6);
}

#[test]
unconstrained fn ragequit_keeps_other_labels() {
    let (h, user, token, label) = holder();
    let other = Deposit { amount: 7, nullifier: 0x4e11f1e8, change_precommitment: 0x9c0a18, label: K, claim_salt: 0x5a18 };
    fund(h, token, PORTAL_A, user, other);
    ragequit(h, user, token, PAYEE, 10, label);
    assert_eq(label_balance(h, token, user, label), 0);
    assert_eq(label_balance(h, token, user, K), 7);
}

// The transaction's only public log is the hub's ticket, and it carries the burn's token, payee,
// amount and label, and nothing that names the holder.
#[test]
unconstrained fn ragequit_ticket_matches_the_burn() {
    let (h, user, token, label) = holder();
    ragequit(h, user, token, PAYEE, 4, label);
    let tx_hash = get_last_tx_effects().tx_hash;
    let effect = h.env.utility_context(|_| get_tx_effects(EphemeralArray::from_array([tx_hash])).get(0)).unwrap();
    assert_eq(effect.revert_code, 0);

    let tag = compute_log_tag(
        TokenBridgeHub::RagequitTicket::get_event_type_id().to_field(),
        DOM_SEP__EVENT_LOG_TAG,
    );
    let expected = [5, h.hub.to_field(), tag, token.to_field(), PAYEE.to_field(), 4, label];
    let logs = effect.public_logs;
    assert_eq(logs.length, 7, "exactly one public log, of the ticket's size");
    for i in 0..7 {
        assert_eq(logs.payload[i], expected[i]);
    }
    for i in 0..logs.length {
        assert(logs.payload[i] != user.to_field(), "a public log names the holder");
    }
}

#[test(should_fail_with = "AmountOutOfRange")]
unconstrained fn ragequit_failure_zero_amount() {
    let (h, user, token, label) = holder();
    ragequit(h, user, token, PAYEE, 0, label);
}

#[test(should_fail_with = "ZeroPayee")]
unconstrained fn ragequit_failure_zero_payee() {
    let (h, user, token, label) = holder();
    ragequit(h, user, token, EthAddress::zero(), 11, label);
}

#[test(should_fail_with = "exit payee is the portal")]
unconstrained fn ragequit_failure_portal_payee() {
    let (h, user, token, label) = holder();
    ragequit(h, user, token, PORTAL_A, 11, label);
}

// `EthAddress::from_field` range-checks; deserializing keeps the raw word, as a raw L2 caller's does.
#[test(should_fail_with = "PayeeOutOfRange")]
unconstrained fn ragequit_failure_wide_payee() {
    let (h, user, token, label) = holder();
    let wide = EthAddress::deserialize([0x10000000000000000000000000000000000000000]);
    ragequit(h, user, token, wide, 11, label);
}

#[test(should_fail_with = "LabelOutOfRange")]
unconstrained fn ragequit_failure_zero_label() {
    let (h, user, token, _) = holder();
    ragequit(h, user, token, PAYEE, 11, 0);
}

#[test(should_fail_with = "Trying to read from uninitialized PublicImmutable")]
unconstrained fn ragequit_failure_unregistered_token() {
    let (h, user, _, label) = holder();
    ragequit(h, user, AztecAddress::from_field(0xDEAD), PAYEE, 11, label);
}

// An affordable amount of a label the caller never held.
#[test(should_fail_with = "Balance too low")]
unconstrained fn ragequit_failure_other_label() {
    let (h, user, token, _) = holder();
    ragequit(h, user, token, PAYEE, 5, K);
}

#[test(should_fail_with = "Balance too low")]
unconstrained fn ragequit_failure_over_balance() {
    let (h, user, token, label) = holder();
    ragequit(h, user, token, PAYEE, 11, label);
}
