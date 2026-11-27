// Shields and the birth-origin notes they create. A contract call's `random` is answered by the TXE
// server, out of `OracleMock`'s reach, so a test reads the secret from the announcement TXE delivers to
// the intake's event store, as the bot does.
use crate::{
    LabelledToken,
    note::ORIGIN_BIRTH,
    test::{
        paths::{BIRTH_ROOT, POOL_PATHS, POOL_ROOT},
        utils::{
            assert_labels, balance, L, labels, mint, post, post_now, public_balance, ragequit, setup, Setup,
            setup_with_registry, transfer, unshield,
        },
    },
};
use asp_registry::{AspRootRegistry, label_check::LabelPath};
use aztec::{
    event::EventSelector,
    protocol::{
        address::AztecAddress,
        constants::{
            DOM_SEP__EVENT_COMMITMENT, DOM_SEP__MESSAGE_NULLIFIER, DOM_SEP__NOTE_NULLIFIER,
            DOM_SEP__PRIVATE_INITIALIZATION_NULLIFIER, DOM_SEP__PROTOCOL_NULLIFIER,
            DOM_SEP__PUBLIC_INITIALIZATION_NULLIFIER, DOM_SEP__SILOED_NULLIFIER,
        },
        hash::compute_siloed_nullifier,
        traits::FromField,
    },
    test::helpers::txe_oracles::get_last_tx_effects,
};
use pp_hash::{
    birth::{
        birth_label, birth_nullifier, DOM_SEP__PP_BIRTH_ID, DOM_SEP__PP_BIRTH_LABEL, DOM_SEP__PP_BIRTH_NULLIFIER,
    },
    hash_1,
    MAX_DEPTH,
};

/// `user` holds 50 publicly, unshielded from a pool note.
unconstrained fn funded() -> Setup {
    let s = setup();
    mint(s, s.user, 50, L);
    post_now(s, POOL_ROOT, BIRTH_ROOT);
    unshield(s, s.user, 50, L, POOL_PATHS[0]);
    s
}

unconstrained fn shield(s: Setup, amount: u128) {
    s.env.call_private(s.user, LabelledToken::at(s.token).shield(amount));
}

// aztec-nr keeps its binding to TXE's private-event store crate-private; the sizes are its own.
#[oracle(aztec_txe_getPrivateEvents)]
unconstrained fn private_events(
    selector: EventSelector,
    contract_address: AztecAddress,
    scope: AztecAddress,
) -> BoundedVec<BoundedVec<Field, 10>, 5> {}

pub struct Birth {
    pub label: Field,
    pub secret: Field,
    pub owner: AztecAddress,
    pub amount: u128,
}

/// The announcements `intake` has received, oldest first.
unconstrained fn announcements(s: Setup, intake: AztecAddress) -> BoundedVec<Birth, 5> {
    // A utility call runs the token's sync, which discovers the intake's messages.
    let _ = balance(s, intake);
    let selector = EventSelector::from_signature("BirthAnnouncement(Field,Field,(Field),u128)");
    let raw = private_events(selector, s.token, intake);
    let mut out = BoundedVec::new();
    for i in 0..raw.len() {
        let f = raw.get(i);
        out.push(Birth {
            label: f.get(0),
            secret: f.get(1),
            owner: AztecAddress::from_field(f.get(2)),
            amount: f.get(3) as u128,
        });
    }
    out
}

/// `user` shields `amount`; returns the announcement the setup's intake (`admin`) received.
unconstrained fn born(s: Setup, amount: u128) -> Birth {
    shield(s, amount);
    let births = announcements(s, s.admin);
    births.get(births.len() - 1)
}

/// A one-label tree: the root is the label's leaf and the path has depth 0.
fn solo(label: Field) -> (Field, LabelPath) {
    (hash_1([label]), LabelPath { index: 0, depth: 0, siblings: [0; MAX_DEPTH] })
}

/// The poster's next post, after every block so far, and an anchor one second later.
unconstrained fn repost(s: Setup, sequence: u64, pool_root: Field, birth_root: Field) {
    let now = s.env.last_block_timestamp() + 10;
    post(s, now, sequence, pool_root, birth_root);
    s.env.mine_block_at(now + 1);
}

unconstrained fn set_intake(s: Setup, intake: AztecAddress) {
    s.env.call_public(s.admin, AspRootRegistry::at(s.registry).set_birth_intake(intake));
}

#[test]
unconstrained fn shield_creates_birth_note() {
    let s = funded();
    shield(s, 40);
    let effects = get_last_tx_effects();
    assert_eq(public_balance(s, s.user), 10);
    let births = announcements(s, s.admin);
    assert_eq(births.len(), 1);
    let b = births.get(0);
    assert((b.owner == s.user) & (b.amount == 40));
    assert_eq(b.label, birth_label(s.token, s.user, 40, b.secret));
    assert_labels(s, s.user, [(b.label, ORIGIN_BIRTH, 40)]);
    let siloed = compute_siloed_nullifier(s.token, birth_nullifier(s.user, b.secret));
    assert(effects.nullifiers.any(|n| n == siloed));
}

#[test]
unconstrained fn shield_labels_differ_for_identical_shields() {
    let s = funded();
    let (a, b) = (born(s, 20), born(s, 20));
    assert(a.label != b.label);
    assert_eq(labels(s, s.user).len(), 2);
    assert_eq(balance(s, s.user), 40);
}

// A shield cannot draw its own secret twice in TXE, so the repeat is the same nullifier pushed again
// from the token's address.
#[test(should_fail_with = "NullifierLeafValue is not updateable")]
unconstrained fn shield_failure_repeated_secret() {
    let s = funded();
    let b = born(s, 20);
    let repeat = birth_nullifier(s.user, b.secret);
    // The hub's sole-consumer guard pins this test's name, attribute and next statement; change them with its exemption.
    s.env.private_context_at(s.token, |context| context.push_nullifier_unsafe(repeat));
}

#[test(should_fail_with = "zero amount")]
unconstrained fn shield_failure_zero_amount() {
    let s = funded();
    shield(s, 0);
}

#[test(should_fail_with = "birth intake unset")]
unconstrained fn shield_failure_paused_intake() {
    let s = funded();
    set_intake(s, AztecAddress::zero());
    shield(s, 20);
}

#[test(should_fail_with = "invalid intake")]
unconstrained fn shield_failure_invalid_intake() {
    let s = funded();
    set_intake(s, AztecAddress::from_field(3));
    shield(s, 20);
}

#[test(should_fail_with = "registry unset")]
unconstrained fn shield_failure_unset_registry() {
    let s = setup_with_registry(AztecAddress::zero());
    shield(s, 20);
}

// The debit is the token's own step, so nobody can burn another's public balance through it.
#[test(should_fail_with = "Function debit_for_shield can only be called by the same contract")]
unconstrained fn debit_for_shield_failure_not_self() {
    let s = funded();
    s.env.call_public(s.user, LabelledToken::at(s.token).debit_for_shield(s.user, 1, 0));
}

#[test]
unconstrained fn check_accepts_birth_path() {
    let s = funded();
    let b = born(s, 20);
    let (root, path) = solo(b.label);
    repost(s, 2, POOL_ROOT, root);
    transfer(s, s.user, s.admin, 15, b.label, path);
    assert_labels(s, s.admin, [(b.label, ORIGIN_BIRTH, 15)]);
    assert_labels(s, s.user, [(b.label, ORIGIN_BIRTH, 5)]);
}

#[test(should_fail_with = "NotMember")]
unconstrained fn transfer_private_failure_birth_label_not_yet_approved() {
    let s = funded();
    let b = born(s, 20);
    transfer(s, s.user, s.admin, 20, b.label, solo(b.label).1);
}

#[test]
unconstrained fn shielded_note_ragequits_while_pending() {
    let s = funded();
    let b = born(s, 20);
    ragequit(s, s.user, 15, b.label);
    assert_labels(s, s.user, [(b.label, ORIGIN_BIRTH, 5)]);
    ragequit(s, s.user, 5, b.label);
    assert_eq(balance(s, s.user), 0);
}

#[test(should_fail_with = "root unset")]
unconstrained fn check_failure_zero_birth_root() {
    let s = funded();
    let b = born(s, 20);
    repost(s, 2, POOL_ROOT, 0);
    transfer(s, s.user, s.admin, 20, b.label, solo(b.label).1);
}

// The notes' origin picks the tree: a birth label posted only in the pool tree admits nothing.
#[test(should_fail_with = "NotMember")]
unconstrained fn transfer_private_failure_birth_note_pool_path() {
    let s = funded();
    let b = born(s, 20);
    let (root, path) = solo(b.label);
    repost(s, 2, root, BIRTH_ROOT);
    transfer(s, s.user, s.admin, 20, b.label, path);
}

/// `user` holds `(L′, BIRTH, 20)` and, minted by a faulty minter under the same label, `(L′, POOL, 30)`;
/// the birth tree admits `L′`.
unconstrained fn mixed() -> (Setup, Field) {
    let s = funded();
    let b = born(s, 20);
    mint(s, s.user, 30, b.label);
    let (root, _) = solo(b.label);
    repost(s, 2, POOL_ROOT, root);
    (s, b.label)
}

#[test(should_fail_with = "mixed origin")]
unconstrained fn transfer_private_failure_mixed_origin() {
    let (s, label) = mixed();
    transfer(s, s.user, s.admin, 40, label, solo(label).1);
}

#[test(should_fail_with = "mixed origin")]
unconstrained fn burn_for_exit_failure_mixed_origin() {
    let (s, label) = mixed();
    ragequit(s, s.user, 40, label);
}

// Selection takes the largest note first, so exact chunks of one note each still leave.
#[test]
unconstrained fn burn_for_exit_largest_note_after_mixed_origin() {
    let (s, label) = mixed();
    ragequit(s, s.user, 30, label);
    assert_labels(s, s.user, [(label, ORIGIN_BIRTH, 20)]);
    ragequit(s, s.user, 20, label);
    assert_eq(balance(s, s.user), 0);
}

// The birth nullifier shares the token's nullifier space with every protocol and aztec-nr nullifier.
#[test]
fn birth_separators_distinct_from_aztec_nr() {
    let ours = [DOM_SEP__PP_BIRTH_LABEL, DOM_SEP__PP_BIRTH_NULLIFIER, DOM_SEP__PP_BIRTH_ID];
    let theirs = [
        DOM_SEP__NOTE_NULLIFIER,
        DOM_SEP__SILOED_NULLIFIER,
        DOM_SEP__MESSAGE_NULLIFIER,
        DOM_SEP__EVENT_COMMITMENT,
        DOM_SEP__PROTOCOL_NULLIFIER,
        DOM_SEP__PRIVATE_INITIALIZATION_NULLIFIER,
        DOM_SEP__PUBLIC_INITIALIZATION_NULLIFIER,
        // aztec-nr's own, crate-private upstream (v6.0.0 `test/domain_separators.nr`): initialization,
        // constrained message, single-use claim, tx and authwit nullifiers, and note randomness.
        1653084894,
        3723577546,
        1465998995,
        1025801951,
        1239150694,
        2943528854,
    ];
    for i in 0..ours.len() {
        for j in 0..ours.len() {
            assert((i == j) | (ours[i] != ours[j]));
        }
        for j in 0..theirs.len() {
            assert(ours[i] != theirs[j]);
        }
    }
}
