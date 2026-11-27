use aztec::{macros::notes::note, protocol::traits::{Deserialize, Packable, Serialize}};

/// The registry's own origins, so a note's is the value `check_label` reads: `ORIGIN_POOL` for a bridge
/// claim's label (the pool's tree), `ORIGIN_BIRTH` for a shield's (the birth tree).
pub use asp_registry::label_check::{ORIGIN_BIRTH, ORIGIN_POOL};

/// `value` under a deposit `label`. Only the functions where value enters set `origin`; every other
/// output copies it from the notes it spends, so a note's origin always names the tree that admits its
/// label.
#[derive(Deserialize, Eq, Packable, Serialize)]
#[note]
pub struct LabelledNote {
    pub label: Field,
    pub origin: u8,
    pub value: u128,
}
