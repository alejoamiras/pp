use aztec::macros::aztec;

#[aztec]
pub contract RootRegistry {
    use aztec::{
        macros::{functions::{external, initializer, view}, storage::storage},
        protocol::{address::AztecAddress, traits::{Deserialize, Packable, Serialize}},
        state_vars::{PublicImmutable, PublicMutable},
    };

    /// Packs into three consecutive public slots, in field order: readers read them by slot.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct RootRecord {
        pub sequence: u64,
        pub root: Field,
        pub time: u64,
    }

    #[storage]
    struct Storage<Context> {
        owner: PublicImmutable<AztecAddress, Context>,
        record: PublicMutable<RootRecord, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(owner: AztecAddress) {
        self.storage.owner.initialize(owner);
    }

    /// Replaces the record. Sequences must increase, so an older root cannot land after a newer one; root 0 is
    /// the empty tree's and never valid.
    #[external("public")]
    fn post_root(sequence: u64, root: Field) {
        assert(self.msg_sender() == self.storage.owner.read(), "caller is not the owner");
        assert(root != 0, "zero root");
        assert(sequence > self.storage.record.read().sequence, "sequence not increasing");
        self.storage.record.write(RootRecord { sequence, root, time: self.context.timestamp() });
    }

    #[external("public")]
    #[view]
    fn get_record() -> RootRecord {
        self.storage.record.read()
    }

    #[external("public")]
    #[view]
    fn get_sequence() -> u64 {
        self.storage.record.read().sequence
    }
}
