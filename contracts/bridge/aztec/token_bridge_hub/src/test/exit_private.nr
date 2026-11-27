// As in `ragequit.nr`, each refusal the hub makes before the burn holds 10 and asks 11 (the
// zero-amount case asks 0), so a hub that burned first would fail with the token's message instead.

use crate::test::utils::{
    deposit, fund, Hub, label_balance, PORTAL_A, post_pool_root, post_pool_root_at, register_a, setup_with_asp,
};
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
use pp_hash::{hash_1, LabelPath};

global PAYEE: EthAddress = EthAddress::from_field(0xbeef);
global OTHER_LABEL: Field = 0x6abe1;

/// The path of the registry's only pool label: depth 0, no siblings.
global ONLY_LEAF: LabelPath = LabelPath { index: 0, depth: 0, siblings: [0; 18] };

/// A registered token and an account holding 10 privately under the registry's only pool label.
unconstrained fn holder() -> (Hub, AztecAddress, AztecAddress, Field) {
    let mut h = setup_with_asp();
    let user = h.env.create_light_account();
    let token = register_a(h);
    let mut d = deposit();
    d.amount = 10;
    fund(h, token, PORTAL_A, user, d);
    post_pool_root(h, hash_1([d.label]));
    (h, user, token, d.label)
}

unconstrained fn exit_private(
    h: Hub,
    from: AztecAddress,
    token: AztecAddress,
    payee: EthAddress,
    amount: u128,
    label: Field,
) {
    h.env.call_private(from, TokenBridgeHub::at(h.hub).exit_private(token, payee, amount, label, ONLY_LEAF));
}

#[test]
unconstrained fn exit_private_burns_exactly_and_keeps_change_label() {
    let (h, user, token, label) = holder();
    exit_private(h, user, token, PAYEE, 4, label);
    assert_eq(label_balance(h, token, user, label), 6);
}

// The token's checked burn and the registry read emit nothing, so the ticket is the only public log,
// and it carries no account.
#[test]
unconstrained fn exit_private_ticket_names_no_holder() {
    let (h, user, token, label) = holder();
    exit_private(h, user, token, PAYEE, 4, label);
    let tx_hash = get_last_tx_effects().tx_hash;
    let effect = h.env.utility_context(|_| get_tx_effects(EphemeralArray::from_array([tx_hash])).get(0)).unwrap();
    assert_eq(effect.revert_code, 0);

    let ticket_tag = compute_log_tag(
        TokenBridgeHub::PublicExitTicket::get_event_type_id().to_field(),
        DOM_SEP__EVENT_LOG_TAG,
    );
    let expected = [4, h.hub.to_field(), ticket_tag, token.to_field(), PAYEE.to_field(), 4];
    let logs = effect.public_logs;
    assert_eq(logs.length, 6);
    for i in 0..6 {
        assert_eq(logs.payload[i], expected[i]);
    }
}

#[test(should_fail_with = "AmountOutOfRange")]
unconstrained fn exit_private_failure_zero_amount() {
    let (h, user, token, label) = holder();
    exit_private(h, user, token, PAYEE, 0, label);
}

#[test(should_fail_with = "ZeroPayee")]
unconstrained fn exit_private_failure_zero_payee() {
    let (h, user, token, label) = holder();
    exit_private(h, user, token, EthAddress::zero(), 11, label);
}

#[test(should_fail_with = "exit payee is the portal")]
unconstrained fn exit_private_failure_portal_payee() {
    let (h, user, token, label) = holder();
    exit_private(h, user, token, PORTAL_A, 11, label);
}

// `EthAddress::from_field` range-checks; deserializing keeps the raw word, as a raw L2 caller's does.
#[test(should_fail_with = "PayeeOutOfRange")]
unconstrained fn exit_private_failure_wide_payee() {
    let (h, user, token, label) = holder();
    let wide = EthAddress::deserialize([0x10000000000000000000000000000000000000000]);
    exit_private(h, user, token, wide, 11, label);
}

#[test(should_fail_with = "Trying to read from uninitialized PublicImmutable")]
unconstrained fn exit_private_failure_unregistered_token() {
    let (h, user, _, label) = holder();
    exit_private(h, user, AztecAddress::from_field(0xDEAD), PAYEE, 11, label);
}

// The second post drops the label, so the path that proved it in the first no longer reaches the root.
#[test(should_fail_with = "NotMember")]
unconstrained fn exit_private_failure_revoked_label() {
    let (h, user, token, label) = holder();
    post_pool_root_at(h, 2, hash_1([OTHER_LABEL]));
    exit_private(h, user, token, PAYEE, 4, label);
}

// The record may serve anchors up to `root_time + 1800`; this one is a second past that.
#[test(should_fail_with = "root too old")]
unconstrained fn exit_private_failure_stale_root() {
    let (h, user, token, label) = holder();
    h.env.mine_block_at(h.env.last_block_timestamp() + 1800);
    exit_private(h, user, token, PAYEE, 4, label);
}

#[test(should_fail_with = "Balance too low")]
unconstrained fn exit_private_failure_over_balance() {
    let (h, user, token, label) = holder();
    exit_private(h, user, token, PAYEE, 11, label);
}

// The hub burns its caller's notes only: another account naming the label has none of them.
#[test(should_fail_with = "Balance too low")]
unconstrained fn exit_private_failure_other_accounts_label() {
    let (mut h, _, token, label) = holder();
    let stranger = h.env.create_light_account();
    exit_private(h, stranger, token, PAYEE, 4, label);
}
