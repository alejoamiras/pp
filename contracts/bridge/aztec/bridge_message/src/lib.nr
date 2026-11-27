//! The v1 bridge message contents the hub consumes (Inbox) and emits (Outbox): 32-byte big-endian
//! words hashed with `sha256_to_field`. `@pp/bridge-spec` (TS) is the reference; keystone checks this
//! crate against its generated vectors, and Solidity's `BridgeMessageV1` against the same file.
//! Assert messages are the shared rejection names. `payee != portal` is the hub's check.

use aztec::protocol::address::EthAddress;
use aztec::protocol::hash::sha256_to_field;
use aztec::protocol::traits::ToField;

/// ASCII read as big-endian integers; equal to the Solidity `bytes32` constants.
pub global PP_BRIDGE_IN_V1: Field = 0x70702e6272696467652e696e2e7631;
pub global PP_BRIDGE_OUT_V1: Field = 0x70702e6272696467652e6f75742e7631;
pub global PP_BRIDGE_RAGEQUIT_V1: Field = 0x70702e6272696467652e72616765717569742e7631;

global TWO_POW_160: Field = 0x10000000000000000000000000000000000000000;

/// `H(IN_V1, nullifier, change_commitment, amount)`: the content of the bridge's Inbox message.
pub fn bridge_content_v1(nullifier: Field, change_commitment: Field, amount: u128) -> Field {
    assert(amount != 0, "AmountOutOfRange");
    sha256_to_field(words::<4, 128>([PP_BRIDGE_IN_V1, nullifier, change_commitment, amount as Field]))
}

/// `H(OUT_V1, payee, amount)`: the content of a screened exit's Outbox message (`exit_public` or
/// `exit_private`).
pub fn exit_content_v1(payee: EthAddress, amount: u128) -> Field {
    let payee = payee_word(payee);
    assert(amount != 0, "AmountOutOfRange");
    sha256_to_field(words::<3, 96>([PP_BRIDGE_OUT_V1, payee, amount as Field]))
}

/// `H(RAGEQUIT_V1, payee, amount, label)`: the content of a ragequit's Outbox message. Label 0 is
/// refused, so `ExitSettled`'s label 0 always means an `OUT_V1` exit.
pub fn ragequit_content_v1(payee: EthAddress, amount: u128, label: Field) -> Field {
    let payee = payee_word(payee);
    assert(amount != 0, "AmountOutOfRange");
    assert(label != 0, "LabelOutOfRange");
    sha256_to_field(words::<4, 128>([PP_BRIDGE_RAGEQUIT_V1, payee, amount as Field, label]))
}

// EthAddress defers its 160-bit check to the kernel tail, which never sees a payee inside content:
// a wider word would hash to a content Solidity's `address` can never rebuild.
fn payee_word(payee: EthAddress) -> Field {
    let word = payee.to_field();
    assert(word != 0, "ZeroPayee");
    assert(word.lt(TWO_POW_160), "PayeeOutOfRange");
    word
}

fn words<let N: u32, let M: u32>(values: [Field; N]) -> [u8; M] {
    std::static_assert(M == N * 32, "M must be 32 bytes per word");
    let mut out = [0; M];
    for i in 0..N {
        let word: [u8; 32] = values[i].to_be_bytes();
        for j in 0..32 {
            out[i * 32 + j] = word[j];
        }
    }
    out
}
