//! Hashes of a label born on Aztec by a shield. The bot recomputes them (TS `@pp/bridge-spec/birth`)
//! to approve a birth, so a drift leaves valid births pending.

use aztec::protocol::address::AztecAddress;
use aztec::protocol::hash::poseidon2_hash_with_separator;
use aztec::protocol::traits::ToField;

/// Frozen separators: the ASCII words "pbl1", "pbn1", "pbi1".
pub global DOM_SEP__PP_BIRTH_LABEL: u32 = 0x70626c31;
pub global DOM_SEP__PP_BIRTH_NULLIFIER: u32 = 0x70626e31;
pub global DOM_SEP__PP_BIRTH_ID: u32 = 0x70626931;

/// `label′`, the label of the shielded note.
pub fn birth_label(token: AztecAddress, owner: AztecAddress, amount: u128, birth_secret: Field) -> Field {
    poseidon2_hash_with_separator(
        [token.to_field(), owner.to_field(), amount as Field, birth_secret],
        DOM_SEP__PP_BIRTH_LABEL,
    )
}

/// The inner birth nullifier; the protocol silos it by the pushing contract (the token).
pub fn birth_nullifier(owner: AztecAddress, birth_secret: Field) -> Field {
    poseidon2_hash_with_separator([owner.to_field(), birth_secret], DOM_SEP__PP_BIRTH_NULLIFIER)
}

/// The id the shield's public debit emits.
pub fn birth_id(label: Field, birth_secret: Field) -> Field {
    poseidon2_hash_with_separator([label, birth_secret], DOM_SEP__PP_BIRTH_ID)
}
