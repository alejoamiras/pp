// Adapted from aztec-standards v6.0.0 (`balance_set`, `MultiBalanceSet`).
// Copyright (c) 2024-2026 Aztec Foundation. MIT License; see THIRD_PARTY_LICENSE.
use crate::note::LabelledNote;
use aztec::{
    context::{PrivateContext, UtilityContext},
    messages::delivery::{MessageDelivery, OnchainConstrainedDelivery},
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

/// Notes one call may spend. A larger amount takes several calls.
pub global MAX_NOTES: u32 = 8;
/// Distinct labels one `labels` page returns.
pub global LABELS_PER_PAGE: u32 = 16;
/// Note values one `values_of` page returns: one note-viewer page.
pub global VALUES_PER_PAGE: u32 = 10;
/// Distinct (label, origin) pairs `labels` can aggregate for one owner.
pub global MAX_TRACKED_LABELS: u32 = 256;

/// Every balance note is delivered this way. Constrained, so a dishonest sender cannot commit a note
/// whose log its owner cannot find. A non-interactive handshake, so the wallet cannot pick an
/// interactive one, which publishes nothing on chain and fails while the recipient is offline. An
/// existing handshake for the pair, of either kind, is still reused.
pub fn delivery() -> OnchainConstrainedDelivery {
    let mut mode = MessageDelivery::onchain_constrained();
    mode.via_non_interactive_handshake()
}

/// One owner's labelled notes. Spends are scoped to one label by a select that the note getter
/// re-checks in the circuit.
pub struct LabelledBalanceSet<Context> {
    set: PrivateSet<LabelledNote, Context>,
}

impl<Context> OwnedStateVariable<Context> for LabelledBalanceSet<Context> {
    fn new(context: Context, storage_slot: Field, owner: AztecAddress) -> Self {
        Self { set: PrivateSet::new(context, storage_slot, owner) }
    }
}

impl LabelledBalanceSet<&mut PrivateContext> {
    /// Credits `amount` under `label` and `origin`. A zero amount writes no note.
    pub fn add(self, label: Field, origin: u8, amount: u128) {
        if amount != 0 {
            self.set.insert(LabelledNote { label, origin, value: amount }).deliver(delivery());
        }
    }

    /// Nullifies up to `MAX_NOTES` notes of `label`, largest first, stopping once `amount` is covered.
    /// The PXE picks the notes; the circuit checks only their label and that they descend. Returns
    /// their total and their common origin; fails if they disagree on origin. The total may fall
    /// short of `amount`; the caller decides.
    pub fn try_sub(self, label: Field, amount: u128) -> (u128, u8) {
        let options = NoteGetterOptions::with_preprocessor(preprocess_min_sum, amount)
            .select(LabelledNote::properties().label, Comparator.EQ, label)
            .sort(LabelledNote::properties().value, SortOrder.DESC)
            .set_limit(MAX_NOTES);
        let notes = self.set.pop_notes(options);
        let mut total = 0 as u128;
        let mut origin = 0 as u8;
        for i in 0..options.limit {
            if i < notes.len() {
                let note = notes.get_unchecked(i);
                if i == 0 {
                    origin = note.origin;
                }
                assert(note.origin == origin, "mixed origin");
                total += note.value;
            }
        }
        (total, origin)
    }
}

impl LabelledBalanceSet<UtilityContext> {
    pub unconstrained fn balance_of(self) -> u128 {
        let mut total = 0 as u128;
        let mut offset = 0;
        let mut more = true;
        while more {
            let notes = self.set.view_notes(NoteViewerOptions::new().set_offset(offset));
            for i in 0..notes.len() {
                total += notes.get(i).value;
            }
            offset += notes.len();
            more = notes.len() == notes.max_len();
        }
        total
    }

    /// `(label, origin, balance)` per distinct label, in first-seen order, from the `start`-th label.
    /// Reads every note page; past `MAX_TRACKED_LABELS` distinct (label, origin) pairs every page fails.
    pub unconstrained fn labels(
        self,
        start: u32,
    ) -> BoundedVec<(Field, u8, u128), LABELS_PER_PAGE> {
        let mut seen: BoundedVec<(Field, u8, u128), MAX_TRACKED_LABELS> = BoundedVec::new();
        let mut note_offset = 0;
        let mut more = true;
        while more {
            let notes = self.set.view_notes(NoteViewerOptions::new().set_offset(note_offset));
            for i in 0..notes.len() {
                let note = notes.get(i);
                let mut found = false;
                for j in 0..seen.len() {
                    let (label, origin, sum) = seen.get(j);
                    if !found & (label == note.label) & (origin == note.origin) {
                        seen.set(j, (label, origin, sum + note.value));
                        found = true;
                    }
                }
                if !found {
                    assert(seen.len() < MAX_TRACKED_LABELS, "too many labels");
                    seen.push((note.label, note.origin, note.value));
                }
            }
            note_offset += notes.len();
            more = notes.len() == notes.max_len();
        }
        let mut page = BoundedVec::new();
        for j in start..seen.len() {
            if page.len() < LABELS_PER_PAGE {
                page.push(seen.get(j));
            }
        }
        page
    }

    /// The values of `label`'s notes, largest first, from the `start`-th: the amounts a caller needs
    /// to spend exact chunks of at most `MAX_NOTES` notes.
    pub unconstrained fn values_of(
        self,
        label: Field,
        start: u32,
    ) -> BoundedVec<u128, VALUES_PER_PAGE> {
        let options = NoteViewerOptions::new()
            .select(LabelledNote::properties().label, Comparator.EQ, label)
            .sort(LabelledNote::properties().value, SortOrder.DESC)
            .set_offset(start);
        let notes = self.set.view_notes(options);
        let mut values = BoundedVec::new();
        for i in 0..notes.len() {
            values.push(notes.get(i).value);
        }
        values
    }
}

/// Keeps notes, in retrieved (value-descending) order, until their sum reaches `min_sum`. It runs
/// unconstrained: a prover that bypasses it only chooses which of its own notes of the label to
/// spend, and the caller still checks the total.
pub fn preprocess_min_sum(
    notes: [Option<HintedNote<LabelledNote>>; MAX_NOTE_HASH_READ_REQUESTS_PER_CALL],
    min_sum: u128,
) -> [Option<HintedNote<LabelledNote>>; MAX_NOTE_HASH_READ_REQUESTS_PER_CALL] {
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
