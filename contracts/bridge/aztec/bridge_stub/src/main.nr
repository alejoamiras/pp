use aztec::macros::aztec;

/// The bridge hub's stand-in in the token's tests: it is the token's minter, and it burns for its own
/// caller, as the hub does. Tests that call the token directly as the minter would pass in the TXE's
/// shared key store where the network would reject them.
#[aztec]
pub contract BridgeStub {
    use aztec::{
        context::gas::GasOpts,
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
    global BURN_PUBLIC_FOR_EXIT: FunctionSelector =
        comptime { FunctionSelector::from_signature("burn_public_for_exit((Field),u128)") };
    // `LabelPath` is `{ index: u32, depth: u8, siblings: [Field; 18] }`.
    global BURN_CHECKED_FOR_EXIT: FunctionSelector = comptime {
        FunctionSelector::from_signature("burn_checked_for_exit((Field),u128,Field,(u32,u8,[Field;18]))")
    };

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

    #[external("private")]
    fn exit_checked(token: AztecAddress, amount: u128, label: Field, index: u32, depth: u8, siblings: [Field; 18]) {
        let from = self.msg_sender();
        let mut args = [0; 23];
        args[0] = from.to_field();
        args[1] = amount as Field;
        args[2] = label;
        args[3] = index as Field;
        args[4] = depth as Field;
        for i in 0..18 {
            args[5 + i] = siblings[i];
        }
        let _ = self.context.call_private_function(token, BURN_CHECKED_FOR_EXIT, args);
    }

    #[external("public")]
    fn ragequit_public(token: AztecAddress, amount: u128) {
        let from = self.msg_sender();
        let _ = self.context.call_public_function(
            token,
            BURN_PUBLIC_FOR_EXIT,
            [from.to_field(), amount as Field],
            GasOpts::default(),
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
