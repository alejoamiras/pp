// Adapted from aztec-standards' MultiTokenNote. Copyright (c) 2024-2026 Aztec Foundation, MIT License.
// The label moves from a public completion field into the private commitment.
use aztec::{
    context::{PrivateContext, PublicContext},
    keys::getters::{get_nhk_app, get_public_keys, try_get_public_keys},
    macros::notes::custom_note,
    messages::{
        delivery::{do_private_message_delivery, MessageDeliveryBuilder},
        logs::partial_note::encode_partial_note_private_message,
    },
    note::{
        note_interface::{NoteHash, NoteType},
        partial_note::{DOM_SEP__NOTE_COMPLETION_LOG_TAG, DOM_SEP__PARTIAL_NOTE_COMMITMENT},
        utils::{compute_note_hash, compute_note_nullifier},
    },
    oracle::random::random,
    protocol::{
        address::AztecAddress,
        constants::DOM_SEP__PARTIAL_NOTE_VALIDITY_COMMITMENT,
        hash::{compute_log_tag, poseidon2_hash_with_separator, sha256_to_field},
        traits::{Deserialize, FromField, Packable, Serialize, ToField},
    },
};

global DOM_SEP__PARTIAL_NOTE_COMPLETION: Field =
    sha256_to_field("PP_SPIKE::PARTIAL_NOTE_COMPLETION".as_bytes());

/// `{label, value}`. Field order matters: partial-note discovery rebuilds the packed note as the private content
/// (`[label]`) followed by the completion log after the slot (`[value]`).
#[derive(Deserialize, Eq, Serialize, Packable)]
#[custom_note]
pub struct LabelNote {
    pub label: Field,
    pub value: u128,
}

impl NoteHash for LabelNote {
    // Hashed as a completed partial note so that full and partial notes are indistinguishable once created.
    fn compute_note_hash(
        self,
        owner: AztecAddress,
        storage_slot: Field,
        randomness: Field,
    ) -> Field {
        PartialLabelNote { commitment: compute_partial_commitment(owner, self.label, randomness) }
            .compute_complete_note_hash(storage_slot, self.value)
    }

    fn compute_nullifier(
        self,
        context: &mut PrivateContext,
        owner: AztecAddress,
        note_hash_for_nullification: Field,
    ) -> Field {
        let secret = context.request_nhk_app(get_public_keys(owner).npk_m_hash);
        compute_note_nullifier(note_hash_for_nullification, [secret])
    }

    unconstrained fn compute_nullifier_unconstrained(
        self,
        owner: AztecAddress,
        note_hash_for_nullification: Field,
    ) -> Option<Field> {
        try_get_public_keys(owner).map(|keys| {
            compute_note_nullifier(note_hash_for_nullification, [get_nhk_app(keys.npk_m_hash)])
        })
    }
}

impl LabelNote {
    /// Commits to `owner` and `label` now; `PartialLabelNote::complete` adds the value later, in public. Only
    /// `completer` can complete it. `delivery` carries the owner's private message.
    pub fn partial<D>(
        owner: AztecAddress,
        label: Field,
        context: &mut PrivateContext,
        completer: AztecAddress,
        delivery: D,
    ) -> PartialLabelNote
    where
        D: MessageDeliveryBuilder,
    {
        // Safety: the randomness keeps owner and label from being brute-forced out of the public commitment; a
        // preparer that skews it already knows both.
        let randomness = unsafe { random() };
        let commitment = compute_partial_commitment(owner, label, randomness);
        let content = LabelPartialNotePrivateContent { label };
        // The raw commitment goes in as the completion log tag; discovery applies DOM_SEP__NOTE_COMPLETION_LOG_TAG.
        do_private_message_delivery(
            context,
            || encode_partial_note_private_message(content, owner, randomness, commitment),
            Option::none(),
            owner,
            delivery,
        );
        let partial = PartialLabelNote { commitment };
        context.push_nullifier_unsafe(partial.compute_validity_commitment(completer));
        partial
    }
}

fn compute_partial_commitment(owner: AztecAddress, label: Field, randomness: Field) -> Field {
    poseidon2_hash_with_separator(
        [owner.to_field(), label, randomness],
        DOM_SEP__PARTIAL_NOTE_COMMITMENT,
    )
}

#[derive(Packable)]
struct LabelPartialNotePrivateContent {
    label: Field,
}

impl NoteType for LabelPartialNotePrivateContent {
    fn get_id() -> Field {
        LabelNote::get_id()
    }
}

#[derive(Packable, Serialize, Deserialize, Eq)]
pub struct PartialLabelNote {
    pub commitment: Field,
}

impl PartialLabelNote {
    /// Completes the note with `value`. The completion nullifier is keyed by the commitment alone, so a second
    /// completion by anyone reverts. The public log carries the slot and value, never the label.
    pub fn complete(
        self,
        context: PublicContext,
        completer: AztecAddress,
        storage_slot: Field,
        value: u128,
    ) {
        // Token policy, as in aztec-nr's UintNote: a completion never creates a zero-value note.
        assert(value != 0, "zero completion");
        assert(
            context.nullifier_exists_unsafe(
                self.compute_validity_commitment(completer),
                context.this_address(),
            ),
            "invalid partial note or completer",
        );
        context.push_nullifier_unsafe(poseidon2_hash_with_separator(
            [self.commitment],
            DOM_SEP__PARTIAL_NOTE_COMPLETION,
        ));
        let log_tag = compute_log_tag(self.commitment, DOM_SEP__NOTE_COMPLETION_LOG_TAG);
        context.emit_public_log_unsafe(log_tag, [storage_slot, value.to_field()]);
        context.push_note_hash(self.compute_complete_note_hash(storage_slot, value));
    }

    fn compute_validity_commitment(self, completer: AztecAddress) -> Field {
        poseidon2_hash_with_separator(
            [self.commitment, completer.to_field()],
            DOM_SEP__PARTIAL_NOTE_VALIDITY_COMMITMENT,
        )
    }

    fn compute_complete_note_hash(self, storage_slot: Field, value: u128) -> Field {
        compute_note_hash(storage_slot, [self.commitment, value.to_field()])
    }
}

impl ToField for PartialLabelNote {
    fn to_field(self) -> Field {
        self.commitment
    }
}

impl FromField for PartialLabelNote {
    fn from_field(field: Field) -> Self {
        Self { commitment: field }
    }
}
