// TXE harness for the hub. The TXE cannot execute the protocol class-registry path the hub's
// `register_token` takes to publish a token instance (it never mines class nullifiers), so tests
// pre-register the instance through the raw deploy oracle — same salt, same initializer args, same
// `deployer = hub`, constructor NOT called — and drive the publish-free `bind_token`. The hub's own
// enqueued constructor then initializes the token exactly as in production.

use crate::TokenBridgeHub;
use aztec::{
    hash::compute_secret_hash,
    protocol::{
        address::{AztecAddress, EthAddress}, contract_class_id::ContractClassId,
        contract_instance::ContractInstance, traits::ToField, utils::field::field_from_bytes,
    },
    test::helpers::{test_environment::TestEnvironment, txe_oracles},
};
use labelled_token::LabelledToken;
use register_hash_lib::{BIND_HARNESS_SECRET, get_register_content_hash};

/// The sibling crate's committed artifact, resolved by the TXE as `<dir>/target/<pkg>-<Name>.json`.
pub global LABELLED_TOKEN: str<46> = "../labelled_token@labelled_token/LabelledToken";

/// The L1 factory identity the hub binds at construction — the only sender whose `register`
/// messages it consumes.
pub global FACTORY: EthAddress = EthAddress::from_field(0xFAC7);

pub struct Hub {
    pub env: TestEnvironment,
    pub admin: AztecAddress,
    pub hub: AztecAddress,
    pub token_class_id: ContractClassId,
    pub registry: AztecAddress,
}

/// The L1 word for a 31-char string: `0x00 ‖ b0..b30` as a big-endian field, exactly what
/// PortalFactory.sol commits and what `FieldCompressedString` stores.
pub unconstrained fn word(s: str<31>) -> Field {
    field_from_bytes(s.as_bytes(), true)
}

/// Deploys a hub whose generation has no registry, as every stage A generation does.
pub unconstrained fn setup() -> Hub {
    setup_with_registry(AztecAddress::zero())
}

/// Deploys the hub. The token class id is read off a throwaway instance registration because the
/// TXE derives it from the artifact it serves — there is no other source in a Noir test.
pub unconstrained fn setup_with_registry(registry: AztecAddress) -> Hub {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();

    let probe = txe_oracles::deploy(
        LABELLED_TOKEN,
        "constructor",
        LabelledToken::interface()
            .constructor(
                "probe00000000000000000000000000",
                "PRB0000000000000000000000000000",
                0,
                AztecAddress::zero(),
                AztecAddress::zero(),
            )
            .args,
        0,
        0x50726f6265,
        AztecAddress::zero(),
        0,
    );
    let token_class_id = probe.original_contract_class_id;

    let hub_init = TokenBridgeHub::interface().constructor(token_class_id, FACTORY, registry);
    let hub = env.deploy("TokenBridgeHub").with_public_initializer(admin, hub_init);

    Hub { env, admin, hub, token_class_id, registry }
}

/// Registers the token instance the hub will derive for `erc20` (deployer = hub, salt = erc20,
/// constructor NOT called) and returns its address.
pub unconstrained fn pre_register_token(
    h: Hub,
    erc20: EthAddress,
    name: str<31>,
    symbol: str<31>,
    decimals: u8,
) -> AztecAddress {
    let instance: ContractInstance = txe_oracles::deploy(
        LABELLED_TOKEN,
        "constructor",
        LabelledToken::interface().constructor(name, symbol, decimals, h.hub, h.registry).args,
        0,
        erc20.to_field(),
        h.hub,
        // The immutables hash `derive_token` uses; any other value lands at another address.
        0,
    );
    instance.to_address()
}

/// Injects a `register` message committed to the HARNESS secret — the only kind `bind_token`
/// consumes. A real factory commits to `REGISTER_SECRET`, which it cannot.
pub unconstrained fn send_register_message(
    h: Hub,
    erc20: EthAddress,
    portal: EthAddress,
    name_word: Field,
    symbol_word: Field,
    decimals: u8,
) -> Field {
    send_register_message_from(h, FACTORY, erc20, portal, name_word, symbol_word, decimals)
}

/// Injects a message exactly as the REAL factory commits it (secret 0) — which `bind_token` must
/// refuse.
pub unconstrained fn send_factory_register_message(
    h: Hub,
    erc20: EthAddress,
    portal: EthAddress,
    name_word: Field,
    symbol_word: Field,
    decimals: u8,
) -> Field {
    let content = get_register_content_hash(erc20, portal, name_word, symbol_word, decimals);
    h.env.send_l1_to_l2_message_from_secret_hash(
        content,
        register_hash_lib::register_secret_hash(),
        FACTORY,
        h.hub,
    )
}

pub unconstrained fn send_register_message_from(
    h: Hub,
    sender: EthAddress,
    erc20: EthAddress,
    portal: EthAddress,
    name_word: Field,
    symbol_word: Field,
    decimals: u8,
) -> Field {
    let content = get_register_content_hash(erc20, portal, name_word, symbol_word, decimals);
    h.env.send_l1_to_l2_message_from_secret_hash(
        content,
        compute_secret_hash([BIND_HARNESS_SECRET]),
        sender,
        h.hub,
    )
}

// ── Two-token fixtures ─────────────────────────────────────────────────────────────────────

pub global ERC20_A: EthAddress = EthAddress::from_field(0xE2C20A);
pub global PORTAL_A: EthAddress = EthAddress::from_field(0x9017A1A);
pub global NAME_A: str<31> = "Token Alpha00000000000000000000";
pub global SYMBOL_A: str<31> = "ALP0000000000000000000000000000";
pub global ERC20_B: EthAddress = EthAddress::from_field(0xE2C20B);
pub global PORTAL_B: EthAddress = EthAddress::from_field(0x9017A1B);
pub global NAME_B: str<31> = "Token Beta000000000000000000000";
pub global SYMBOL_B: str<31> = "BET0000000000000000000000000000";
pub global DECIMALS: u8 = 18;

pub unconstrained fn register(
    h: Hub,
    erc20: EthAddress,
    portal: EthAddress,
    name: str<31>,
    symbol: str<31>,
    decimals: u8,
) -> AztecAddress {
    let token = pre_register_token(h, erc20, name, symbol, decimals);
    let (name_word, symbol_word) = (word(name), word(symbol));
    let leaf = send_register_message(h, erc20, portal, name_word, symbol_word, decimals);
    h.env.call_private(
        h.admin,
        TokenBridgeHub::at(h.hub).bind_token(erc20, portal, name_word, symbol_word, decimals, leaf),
    );
    token
}

pub unconstrained fn register_a(h: Hub) -> AztecAddress {
    register(h, ERC20_A, PORTAL_A, NAME_A, SYMBOL_A, DECIMALS)
}
