pub mod balance_set;
pub mod note;
mod test;

use aztec::macros::aztec;

/// A token whose every private note carries a deposit label and its origin. Value enters a note only
/// through the bridge's mint, and the bridge's exit burn reads no registry, so a holder can always
/// leave with the notes its wallet can find.
#[aztec]
pub contract LabelledToken {
    use crate::{
        balance_set::{LabelledBalanceSet, LABELS_PER_PAGE, VALUES_PER_PAGE},
        note::ORIGIN_POOL,
    };
    use aztec::{
        macros::{functions::{external, initializer, view}, storage::storage},
        protocol::{address::AztecAddress, traits::{Deserialize, Packable, Serialize}},
        state_vars::{Map, Owned, PublicImmutable, PublicMutable},
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
        private_balances: Owned<LabelledBalanceSet<Context>, Context>,
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

    /// Mints a pool-origin note to `to`. No public effect: the amount stays private.
    #[external("private")]
    fn mint_from_bridge(to: AztecAddress, amount: u128, label: Field) {
        assert(self.msg_sender() == self.storage.config.read().minter, "caller is not minter");
        assert(amount != 0, "zero amount");
        assert(label != 0, "zero label");
        // Delivery to an off-curve address silently encrypts to a random key: nobody could spend or
        // exit the note.
        assert(to.is_valid(), "invalid recipient");
        self.storage.private_balances.at(to).add(label, ORIGIN_POOL, amount);
    }

    /// Burns `amount` of `from`'s `label` notes for the bridge's exit. It reads no registry and sets
    /// no expiry, so it works whatever the registry's state. The change keeps label and origin.
    #[external("private")]
    fn burn_for_exit(from: AztecAddress, amount: u128, label: Field) {
        assert(self.msg_sender() == self.storage.config.read().minter, "caller is not minter");
        assert(amount != 0, "zero amount");
        let balance = self.storage.private_balances.at(from);
        let (taken, origin) = balance.try_sub(label, amount);
        assert(taken >= amount, "Balance too low");
        balance.add(label, origin, taken - amount);
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

    /// Every private note of `owner`, all labels.
    #[external("utility")]
    unconstrained fn balance_of_private(owner: AztecAddress) -> u128 {
        self.storage.private_balances.at(owner).balance_of()
    }

    /// `(label, origin, balance)` per distinct label of `owner`, from the `start`-th label.
    // No parameter of an external function may be named `offset`: aztec-nr's generated call stubs
    // keep a local of that name and would serialize it in place of the argument.
    #[external("utility")]
    unconstrained fn private_balances_by_label(
        owner: AztecAddress,
        start: u32,
    ) -> BoundedVec<(Field, u8, u128), LABELS_PER_PAGE> {
        self.storage.private_balances.at(owner).labels(start)
    }

    /// The values of `owner`'s `label` notes, largest first, from the `start`-th.
    #[external("utility")]
    unconstrained fn private_notes_by_label(
        owner: AztecAddress,
        label: Field,
        start: u32,
    ) -> BoundedVec<u128, VALUES_PER_PAGE> {
        self.storage.private_balances.at(owner).values_of(label, start)
    }
}
