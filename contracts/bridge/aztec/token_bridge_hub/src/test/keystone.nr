// KEYSTONE (no TXE): the hub's in-circuit token derivation must equal bridge-core's
// `deriveHubTokenInstance` (aztec.js `getContractInstanceFromInstantiationParams`) for fixed
// vectors. Both sides compute the address independently; a drift means the app registers an
// instance the hub will never mint to. Run with a name filter so the oracle-less runner skips
// the TXE suite: `aztec-nargo test keystone`.
use crate::TokenBridgeHub;
use aztec::protocol::{
    address::{AztecAddress, EthAddress}, contract_class_id::ContractClassId, traits::{FromField, ToField},
};

// The committed LabelledToken artifact's class — pinned in bridge-core's
// noir-artifact-classids.test.ts as well. Both vectors are the token's own `bench/handoff.json`
// cases, so the token, the hub and bridge-core pin one pair.
global TOKEN_CLASS_ID: Field = 0x1433444ed316fe06e46c3dfb026089b3488dc8b76162d768384a906f6a0c0bbc;

fn derive(registry: Field) -> Field {
    TokenBridgeHub::derive_token(
        AztecAddress::from_field(0x1234000000000000000000000000000000000000000000000000000000000abc),
        ContractClassId::from_field(TOKEN_CLASS_ID),
        EthAddress::from_field(0xe2c20),
        TokenBridgeHub::word_to_str(0x005465737420546f6b656e000000000000000000000000000000000000000000),
        TokenBridgeHub::word_to_str(0x0054535400000000000000000000000000000000000000000000000000000000),
        18,
        AztecAddress::from_field(registry),
    )
        .to_field()
}

#[test]
fn keystone_hub_token_address_matches_bridge_core() {
    assert(derive(0) == 0x216fa64a96f11c2f9373105daaca55ee376e075cbaf464ddb87825e2f94101cf);
}

// The registry is a constructor argument, so it moves the address: a generation with a registry
// derives tokens no registry-free generation can collide with.
#[test]
fn keystone_hub_token_address_binds_the_registry() {
    assert(
        derive(0x7e57) == 0x1593084048a3dd0dea1cb66ca09270c2fdc13d161518cbbaeacdcc9c593baf54,
    );
}

// `to_be_bytes::<31>` range-checks the word before the round-trip assert can even run: a value that
// does not fit 31 bytes fails to decompose.
#[test(should_fail_with = "Field failed to decompose into specified 31 limbs")]
fn keystone_oversized_word_is_rejected() {
    let _ = TokenBridgeHub::word_to_str(0x0100000000000000000000000000000000000000000000000000000000000000);
}
