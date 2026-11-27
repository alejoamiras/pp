pub mod label_check;
mod test;

// The latest ASP roots on Aztec, attested by one poster: `pool_root` is Ethereum's ASP root at
// `l1_block` (checkable there), `birth_root` approves labels born on Aztec (checkable nowhere). The
// admin can only replace the poster, which clears the record, and set the birth intake.

use aztec::macros::aztec;

#[aztec]
pub contract AspRootRegistry {
    use crate::label_check::MAX_OBSERVATION_LAG;
    use pp_hash::MAX_DEPTH;
    use aztec::{
        macros::{events::event, functions::{external, initializer, view}, storage::storage},
        protocol::{address::AztecAddress, traits::{Deserialize, Packable, Serialize}},
        state_vars::{PublicImmutable, PublicMutable},
        utils::WithHash,
    };

    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct RootRecord {
        pub sequence: u64,
        pub pool_root: Field,
        pub birth_root: Field,
        pub l1_block: u64,
        pub root_time: u64,
    }

    // Events keep the order of several updates in one block, which a storage read at its end loses.
    // Storage stays the authority.

    /// Every accepted post, with `RootRecord`'s fields in its order, then `ListSizes`'.
    #[event]
    pub struct RootPosted {
        pub sequence: u64,
        pub pool_root: Field,
        pub birth_root: Field,
        pub l1_block: u64,
        pub root_time: u64,
        pub pool_size: u32,
        pub birth_size: u32,
    }

    /// How many leaves built each root of the current record; zero for a root that is zero. A LeanIMT
    /// root does not fix its leaf count, so a list collapsed into inner nodes builds to the same root:
    /// a client refuses a list whose length differs.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    pub struct ListSizes {
        pub pool: u32,
        pub birth: u32,
    }

    // Raw storage outside `Storage`: the token, hub and probe artifacts embed the registry's storage
    // layout, which their class ids hash. `pool` is here and `birth` one slot up, far above the declared
    // slots; the registry has no maps. "list_sizes" in ASCII.
    pub global SIZES_SLOT: Field = 0x6c6973745f73697a6573;

    // The most leaves a label path can prove membership in.
    global MAX_LIST_SIZE: u32 = 1 << MAX_DEPTH;

    /// `sequence` is the cleared record's own, one past the record the reset replaced; the next post
    /// takes the one after it.
    #[event]
    pub struct PosterChanged {
        pub sequence: u64,
        pub poster: AztecAddress,
    }

    #[event]
    pub struct BirthIntakeChanged {
        pub intake: AztecAddress,
    }

    #[storage]
    struct Storage<Context> {
        admin: PublicImmutable<AztecAddress, Context>,
        poster: PublicMutable<AztecAddress, Context>,
        // Stored with its hash so a private read proves one slot instead of one per field.
        current: PublicMutable<WithHash<RootRecord, 5>, Context>,
        birth_intake: PublicMutable<AztecAddress, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(admin: AztecAddress, poster: AztecAddress, birth_intake: AztecAddress) {
        assert(!admin.is_zero(), "zero admin");
        self.storage.admin.initialize(admin);
        self.storage.poster.write(poster);
        self.storage.birth_intake.write(birth_intake);
    }

    /// `root_time` is the timestamp of Ethereum block `l1_block`, the block the poster read;
    /// `pool_size` and `birth_size` are the lengths of the lists the two roots were built from.
    #[external("public")]
    fn post_root(
        sequence: u64,
        pool_root: Field,
        birth_root: Field,
        l1_block: u64,
        root_time: u64,
        pool_size: u32,
        birth_size: u32,
    ) {
        assert(self.msg_sender() == self.storage.poster.read(), "not poster");
        let current = self.storage.current.read().get_value();
        // A retried or stale post fails instead of overwriting a newer one.
        assert(sequence == current.sequence + 1, "sequence not next");
        assert(pool_root != 0, "zero pool root");
        assert(l1_block >= current.l1_block, "l1 block regressed");
        assert(root_time >= current.root_time, "root time regressed");
        // Guards a bot that reposts a stalled block with its own clock: reposting the same L1 block
        // cannot renew freshness.
        assert((l1_block > current.l1_block) | (root_time == current.root_time), "new time on same block");
        let now = self.context.timestamp();
        assert(root_time <= now, "root time in the future");
        assert(now - root_time <= MAX_OBSERVATION_LAG, "observation too old");
        assert(pool_size != 0, "zero pool size");
        assert((birth_size == 0) == (birth_root == 0), "birth size and root disagree");
        assert((pool_size <= MAX_LIST_SIZE) & (birth_size <= MAX_LIST_SIZE), "size too large");
        self.storage.current.write(WithHash::new(
            RootRecord { sequence, pool_root, birth_root, l1_block, root_time },
        ));
        self.context.storage_write(SIZES_SLOT, ListSizes { pool: pool_size, birth: birth_size });
        self.emit(RootPosted { sequence, pool_root, birth_root, l1_block, root_time, pool_size, birth_size });
    }

    /// A dead address freezes posting. Clearing the block and the time lets the next poster recover
    /// from a stolen key's `l1_block = u64::MAX`. The cleared record takes the next sequence, so a post
    /// prepared against the record it replaces fails as not next. Each post or reset adds one, so the
    /// sequence cannot run out.
    #[external("public")]
    fn set_poster(next: AztecAddress) {
        assert(self.msg_sender() == self.storage.admin.read(), "not admin");
        let sequence = self.storage.current.read().get_value().sequence + 1;
        self.storage.current.write(WithHash::new(
            RootRecord { sequence, pool_root: 0, birth_root: 0, l1_block: 0, root_time: 0 },
        ));
        self.context.storage_write(SIZES_SLOT, ListSizes { pool: 0, birth: 0 });
        self.storage.poster.write(next);
        self.emit(PosterChanged { sequence, poster: next });
    }

    /// Zero pauses shields anchored after it: the token's read of the intake rejects it.
    #[external("public")]
    fn set_birth_intake(next: AztecAddress) {
        assert(self.msg_sender() == self.storage.admin.read(), "not admin");
        self.storage.birth_intake.write(next);
        self.emit(BirthIntakeChanged { intake: next });
    }

    #[external("public")]
    #[view]
    fn get_current() -> RootRecord {
        self.storage.current.read().get_value()
    }

    #[external("public")]
    #[view]
    fn get_sizes() -> ListSizes {
        self.context.storage_read(SIZES_SLOT)
    }

    #[external("public")]
    #[view]
    fn get_admin() -> AztecAddress {
        self.storage.admin.read()
    }

    #[external("public")]
    #[view]
    fn get_poster() -> AztecAddress {
        self.storage.poster.read()
    }

    #[external("public")]
    #[view]
    fn get_birth_intake() -> AztecAddress {
        self.storage.birth_intake.read()
    }
}
