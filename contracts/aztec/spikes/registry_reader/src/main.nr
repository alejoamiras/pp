mod test;

use aztec::macros::aztec;

#[aztec]
pub contract RegistryReader {
    use aztec::{
        history::storage::public_storage_historical_read,
        macros::{functions::{external, initializer, internal, only_self}, storage::storage},
        protocol::address::AztecAddress,
        state_vars::PublicImmutable,
    };
    use root_registry::RootRegistry::{self, RootRecord};

    // Fixed at construction so a caller cannot choose a looser rule or a lookalike registry.
    #[storage]
    struct Storage<Context> {
        registry: PublicImmutable<AztecAddress, Context>,
        max_age: PublicImmutable<u64, Context>,
        window: PublicImmutable<u64, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(registry: AztecAddress, max_age: u64, window: u64) {
        self.storage.registry.initialize(registry);
        self.storage.max_age.initialize(max_age);
        self.storage.window.initialize(window);
    }

    /// Reads the registry's record at the anchor block, requires it fresh enough to stay within `max_age` until
    /// the transaction's expiry, and sets that expiry to `anchor + window`.
    #[external("private")]
    fn check() -> RootRecord {
        self.internal._read_fresh()
    }

    /// As `check`, and also requires the registry not to have moved by the time the transaction lands.
    #[external("private")]
    fn check_current() -> RootRecord {
        let record = self.internal._read_fresh();
        self.enqueue_self._assert_current(record.sequence);
        record
    }

    #[external("public")]
    #[only_self]
    fn _assert_current(sequence: u64) {
        let registry = self.storage.registry.read();
        assert(self.view(RootRegistry::at(registry).get_sequence()) == sequence, "registry moved");
    }

    #[internal("private")]
    fn _read_fresh() -> RootRecord {
        let header = self.context.get_anchor_block_header();
        let registry = self.storage.registry.read();
        let slot = RootRegistry::storage_layout().record.slot;
        // All three reads use the same header, so they come from one consistent state.
        let record = RootRecord {
            sequence: public_storage_historical_read(header, slot, registry) as u64,
            root: public_storage_historical_read(header, slot + 1, registry),
            time: public_storage_historical_read(header, slot + 2, registry) as u64,
        };
        // Unset storage reads as zeros.
        assert(record.sequence != 0, "registry empty");
        let anchor = header.timestamp();
        let window = self.storage.window.read();
        assert(record.time + self.storage.max_age.read() >= anchor + window, "root too old");
        self.context.set_expiration_timestamp(anchor + window);
        record
    }
}
