use crate::test::utils::{ERC20_A, PORTAL_A, setup};
use crate::TokenBridgeHub;
use aztec::protocol::{address::{AztecAddress, EthAddress}, traits::FromField};

// A direct `_register` would let anyone pair an arbitrary token with an arbitrary portal.
#[test(should_fail_with = "can only be called by the same contract")]
unconstrained fn _register_only_self() {
    let mut h = setup();
    let stranger = h.env.create_light_account();
    h.env.call_public(
        stranger,
        TokenBridgeHub::at(h.hub)._register(
            ERC20_A,
            PORTAL_A,
            AztecAddress::from_field(0xDEAD),
        ),
    );
}

// A direct `_exit_ticket` would publish a ticket no burn backs.
#[test(should_fail_with = "can only be called by the same contract")]
unconstrained fn _exit_ticket_only_self() {
    let mut h = setup();
    let stranger = h.env.create_light_account();
    h.env.call_public(
        stranger,
        TokenBridgeHub::at(h.hub)._exit_ticket(AztecAddress::from_field(0xDEAD), EthAddress::from_field(0xbeef), 1),
    );
}

// A direct `_ragequit_ticket` would publish a ticket no burn backs.
#[test(should_fail_with = "can only be called by the same contract")]
unconstrained fn _ragequit_ticket_only_self() {
    let mut h = setup();
    let stranger = h.env.create_light_account();
    h.env.call_public(
        stranger,
        TokenBridgeHub::at(h.hub)._ragequit_ticket(
            AztecAddress::from_field(0xDEAD),
            EthAddress::from_field(0xbeef),
            1,
            0x1abe1,
        ),
    );
}
