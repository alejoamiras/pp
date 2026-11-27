use aztec::{macros::notes::note, protocol::traits::{Deserialize, Packable, Serialize}};

/// The label came from a bridge claim: the pool's tree admits it.
pub global ORIGIN_POOL: u8 = 0;
/// The label was created by a shield: the birth tree admits it.
pub global ORIGIN_BIRTH: u8 = 1;

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
