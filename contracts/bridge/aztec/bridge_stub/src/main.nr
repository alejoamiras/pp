use aztec::macros::aztec;

/// The bridge hub's stand-in in the token's tests: it is the token's minter, and it burns for its own
/// caller, as the hub does. Tests that call the token directly as the minter would pass in the TXE's
/// shared key store where the network would reject them.
#[aztec]
pub contract BridgeStub {
    use aztec::{
        macros::{events::event, functions::external},
        messages::delivery::MessageDelivery,
        protocol::{
            abis::function_selector::FunctionSelector, address::AztecAddress, traits::ToField,
        },
    };

    // Raw selectors: the token's tests import this contract, so it cannot import the token.
    global MINT_FROM_BRIDGE: FunctionSelector =
        comptime { FunctionSelector::from_signature("mint_from_bridge((Field),u128,Field)") };
    global BURN_FOR_EXIT: FunctionSelector =
        comptime { FunctionSelector::from_signature("burn_for_exit((Field),u128,Field)") };

    #[event]
    struct HandshakeProbe {
        value: Field,
    }

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

    /// Another app's message to the caller that opens the caller's self-pair handshake as an
    /// interactive one. Handshakes are per (sender, recipient) and shared across apps, so the token's
    /// later self-deliveries reuse it.
    #[external("private")]
    fn probe_interactive_handshake() {
        let me = self.msg_sender();
        let mut mode = MessageDelivery::onchain_constrained();
        self.emit(HandshakeProbe { value: 1 }).deliver_to(me, mode.via_interactive_handshake());
    }
}
