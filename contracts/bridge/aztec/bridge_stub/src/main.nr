use aztec::macros::aztec;

/// The bridge hub's stand-in in the token's tests: it is the token's minter, and it burns for its own
/// caller, as the hub does. Tests that call the token directly as the minter would pass in the TXE's
/// shared key store where the network would reject them.
#[aztec]
pub contract BridgeStub {
    use aztec::{
        macros::functions::external,
        protocol::{
            abis::function_selector::FunctionSelector, address::AztecAddress, traits::ToField,
        },
    };

    // Raw selectors: the token's tests import this contract, so it cannot import the token.
    global MINT_FROM_BRIDGE: FunctionSelector =
        comptime { FunctionSelector::from_signature("mint_from_bridge((Field),u128,Field)") };
    global BURN_FOR_EXIT: FunctionSelector =
        comptime { FunctionSelector::from_signature("burn_for_exit((Field),u128,Field)") };

    #[external("private")]
    fn mint(token: AztecAddress, to: AztecAddress, amount: u128, label: Field) {
        let _ = self.context.call_private_function(
            token,
            MINT_FROM_BRIDGE,
            [to.to_field(), amount as Field, label],
        );
    }

    #[external("private")]
    fn ragequit(token: AztecAddress, amount: u128, label: Field) {
        let from = self.msg_sender();
        let _ = self.context.call_private_function(
            token,
            BURN_FOR_EXIT,
            [from.to_field(), amount as Field, label],
        );
    }
}
