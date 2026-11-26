mod test;

use aztec::macros::aztec;

/// A token whose every private note carries a deposit label and its origin.
#[aztec]
pub contract LabelledToken {
    use aztec::{
        macros::{functions::{external, initializer, view}, storage::storage},
        protocol::{address::AztecAddress, traits::{Deserialize, Packable, Serialize}},
        state_vars::{Map, PublicImmutable, PublicMutable},
    };
    use compressed_string::FieldCompressedString;

    /// Read together in private, so one immutable holds both. `registry` is zero in a generation that
    /// has no checked spends.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct Config {
        pub minter: AztecAddress,
        pub registry: AztecAddress,
    }

    #[storage]
    struct Storage<Context> {
        name: PublicImmutable<FieldCompressedString, Context>,
        symbol: PublicImmutable<FieldCompressedString, Context>,
        decimals: PublicImmutable<u8, Context>,
        config: PublicImmutable<Config, Context>,
        public_balances: Map<AztecAddress, PublicMutable<u128, Context>, Context>,
    }

    /// The hub derives this token's address from these arguments, so their order and types are
    /// fixed for every generation.
    #[external("public")]
    #[initializer]
    fn constructor(
        name: str<31>,
        symbol: str<31>,
        decimals: u8,
        minter: AztecAddress,
        registry: AztecAddress,
    ) {
        assert(!minter.is_zero(), "zero minter");
        self.storage.name.initialize(FieldCompressedString::from_string(name));
        self.storage.symbol.initialize(FieldCompressedString::from_string(symbol));
        self.storage.decimals.initialize(decimals);
        self.storage.config.initialize(Config { minter, registry });
    }

    #[external("public")]
    #[view]
    fn name() -> FieldCompressedString {
        self.storage.name.read()
    }

    #[external("public")]
    #[view]
    fn symbol() -> FieldCompressedString {
        self.storage.symbol.read()
    }

    #[external("public")]
    #[view]
    fn decimals() -> u8 {
        self.storage.decimals.read()
    }
}
