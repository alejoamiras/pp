// Adapted from aztec-standards' MultiBalanceSet. Copyright (c) 2024-2026 Aztec Foundation, MIT License.
use crate::label_note::LabelNote;
use aztec::{
    context::{PrivateContext, UtilityContext},
    messages::delivery::{MessageDelivery, MessageDeliveryBuilder},
    note::{
        HintedNote,
        note_getter_options::{NoteGetterOptions, SortOrder},
        note_interface::NoteProperties,
        note_viewer_options::NoteViewerOptions,
    },
    protocol::{address::AztecAddress, constants::MAX_NOTE_HASH_READ_REQUESTS_PER_CALL},
    state_vars::{OwnedStateVariable, PrivateSet},
    utils::comparison::Comparator,
};

/// One owner's `LabelNote`s; every operation is scoped to one label by a constrained `select`.
pub struct LabelBalanceSet<Context> {
    set: PrivateSet<LabelNote, Context>,
}

impl<Context> OwnedStateVariable<Context> for LabelBalanceSet<Context> {
    fn new(context: Context, storage_slot: Field, owner: AztecAddress) -> Self {
        Self { set: PrivateSet::new(context, storage_slot, owner) }
    }
}

impl LabelBalanceSet<UtilityContext> {
    pub unconstrained fn balance_of(self, label: Field) -> u128 {
        self.balance_from(label, 0)
    }

    unconstrained fn balance_from(self, label: Field, offset: u32) -> u128 {
        let mut options = NoteViewerOptions::new();
        let notes = self.set.view_notes(options.set_offset(offset).select(
            LabelNote::properties().label,
            Comparator.EQ,
            label,
        ));
        let mut balance = 0 as u128;
        for i in 0..options.limit {
            if i < notes.len() {
                balance += notes.get_unchecked(i).value;
            }
        }
        if notes.len() == options.limit {
            balance += self.balance_from(label, offset + options.limit);
        }
        balance
    }
}

impl LabelBalanceSet<&mut PrivateContext> {
    /// Credits `amount` under `label`, delivered with constrained on-chain delivery. A zero amount writes no note.
    pub fn add(self, label: Field, amount: u128) {
        self.add_with(label, amount, MessageDelivery::onchain_constrained());
    }

    pub fn add_with<D>(self, label: Field, amount: u128, delivery: D)
    where
        D: MessageDeliveryBuilder,
    {
        if amount != 0 {
            self.set.insert(LabelNote { label, value: amount }).deliver(delivery);
        }
    }

    /// Nullifies up to `max_notes` notes of `label` and returns their total. Only notes with that label can match.
    pub fn try_sub(self, label: Field, amount: u128, max_notes: u32) -> u128 {
        let options = NoteGetterOptions::with_preprocessor(preprocess_min_sum, amount)
            .select(LabelNote::properties().label, Comparator.EQ, label)
            .sort(LabelNote::properties().value, SortOrder.DESC)
            .set_limit(max_notes);
        let notes = self.set.pop_notes(options);
        let mut total = 0 as u128;
        for i in 0..options.limit {
            if i < notes.len() {
                total += notes.get_unchecked(i).value;
            }
        }
        total
    }
}

/// Keeps notes, in retrieved (value-descending) order, until their sum reaches `min_sum`. Unconstrained optimization.
pub fn preprocess_min_sum(
    notes: [Option<HintedNote<LabelNote>>; MAX_NOTE_HASH_READ_REQUESTS_PER_CALL],
    min_sum: u128,
) -> [Option<HintedNote<LabelNote>>; MAX_NOTE_HASH_READ_REQUESTS_PER_CALL] {
    let mut selected = [Option::none(); MAX_NOTE_HASH_READ_REQUESTS_PER_CALL];
    let mut sum = 0 as u128;
    for i in 0..notes.len() {
        if notes[i].is_some() & (sum < min_sum) {
            let hinted = notes[i].unwrap_unchecked();
            selected[i] = Option::some(hinted);
            sum += hinted.note.value;
        }
    }
    selected
}
