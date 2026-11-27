pub mod balance_set;
pub mod note;
mod test;

use aztec::macros::aztec;

/// A token whose every private note carries a deposit label and its origin. Value enters a note only
/// through the bridge's mint (a pool label) or a shield (a new birth label), and the bridge's exit burn
/// reads no registry, so a holder can always leave with the notes its wallet can find.
#[aztec]
pub contract LabelledToken {
    use crate::{
        balance_set::{delivery, LabelledBalanceSet, LABELS_PER_PAGE, VALUES_PER_PAGE},
        note::{ORIGIN_BIRTH, ORIGIN_POOL},
    };
    use asp_registry::label_check::{
        AnchorRoots, assert_current, birth_intake_at_anchor, check_label, LabelPath, SPEND_WINDOW,
    };
    use aztec::{
        macros::{
            events::event,
            functions::{external, initializer, internal, only_self, view},
            storage::storage,
        },
        oracle::random::random,
        protocol::{address::AztecAddress, traits::{Deserialize, FromField, Packable, Serialize}},
        state_vars::{Map, Owned, PublicImmutable, PublicMutable},
    };
    use compressed_string::FieldCompressedString;
    use pp_hash::birth::{birth_id, birth_label, birth_nullifier};

    /// The private side of a public balance change in `Transfer`, as in aztec-standards.
    global PRIVATE_ADDRESS_MAGIC_VALUE: AztecAddress =
        AztecAddress::from_field(0x1ea7e01501975545617c2e694d931cb576b691a4a867fed81ebd3264);

    #[event]
    struct Transfer {
        from: AztecAddress,
        to: AztecAddress,
        amount: u128,
    }

    /// A shield's birth, for the registry's birth intake only: enough to recompute the label and match
    /// the shield's `ShieldDebited`.
    #[event]
    struct BirthAnnouncement {
        label: Field,
        secret: Field,
        owner: AztecAddress,
        amount: u128,
    }

    /// The public side of a shield. `birth_id` ties it to one announcement and reveals the label only
    /// to whoever holds the secret.
    #[event]
    struct ShieldDebited {
        birth_id: Field,
        owner: AztecAddress,
        amount: u128,
    }

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

    /// Pays `amount` of the caller's `label` notes to `to`. The notes' common origin picks the tree
    /// `path` must prove `label` in; the recipient's note and the change keep label and origin.
    #[external("private")]
    fn transfer_private(to: AztecAddress, amount: u128, label: Field, path: LabelPath) {
        assert(!to.is_zero(), "zero recipient");
        // As for a mint: an off-curve recipient's note is encrypted to a random key.
        assert(to.is_valid(), "invalid recipient");
        let (origin, _) = self.internal._checked_debit(self.msg_sender(), amount, label, path);
        self.storage.private_balances.at(to).add(label, origin, amount);
    }

    /// Moves `amount` of the caller's `label` notes to its public balance. The public step checks at
    /// inclusion that both registry roots are still the anchored ones; a change in either tree
    /// reverts the credit and the spend together.
    #[external("private")]
    fn unshield(amount: u128, label: Field, path: LabelPath) {
        // The spend, its change and the queued credit must all be revertible, or a failed public
        // step could not undo them.
        assert(self.context.in_revertible_phase(), "setup phase");
        let owner = self.msg_sender();
        // Nullify and write the change before the enqueue, so a revert of the public step drops all.
        let (_, roots) = self.internal._checked_debit(owner, amount, label, path);
        self.enqueue_self.finish_unshield(owner, amount, roots);
    }

    #[external("public")]
    #[only_self]
    fn finish_unshield(owner: AztecAddress, amount: u128, roots: AnchorRoots) {
        assert_current(self.context, self.storage.config.read().registry, roots);
        self.internal._credit_public(owner, amount);
        self.emit(Transfer { from: PRIVATE_ADDRESS_MAGIC_VALUE, to: owner, amount });
    }

    /// Moves `amount` of the caller's public balance into a birth-origin note under a new label, and
    /// announces the label to the registry's birth intake. The note spends once the birth tree admits
    /// its label; it can be ragequit at any time.
    #[external("private")]
    fn shield(amount: u128) {
        // The note, the birth nullifier and the announcement must revert with the public debit.
        assert(self.context.in_revertible_phase(), "setup phase");
        assert(amount != 0, "zero amount");
        let owner = self.msg_sender();
        // Safety: the prover picks the secret. A repeated one hits the birth nullifier; a guessable one
        // lets a later holder of the label link it to this debit.
        let secret = unsafe { random() };
        let label = birth_label(self.address, owner, amount, secret);
        // The bridge's settlement encoder rejects a zero label: such a note could never exit.
        assert(label != 0, "zero label");
        self.enqueue_self.debit_for_shield(owner, amount, birth_id(label, secret));
        self.context.push_nullifier_unsafe(birth_nullifier(owner, secret));
        self.storage.private_balances.at(owner).add(label, ORIGIN_BIRTH, amount);
        // Read at the anchor, so an intake rotation reaches proofs anchored after it; the expiry bounds
        // how long an older proof still announces to the old intake.
        let intake = birth_intake_at_anchor(self.context, self.storage.config.read().registry);
        // As for a note: an announcement to an off-curve address is encrypted to a random key.
        assert(intake.is_valid(), "invalid intake");
        let anchor = self.context.get_anchor_block_header().timestamp();
        self.context.set_expiration_timestamp(anchor + SPEND_WINDOW);
        self.emit(BirthAnnouncement { label, secret, owner, amount }).deliver_to(intake, delivery());
    }

    #[external("public")]
    #[only_self]
    fn debit_for_shield(owner: AztecAddress, amount: u128, birth_id: Field) {
        self.internal._debit_public(owner, amount);
        self.emit(ShieldDebited { birth_id, owner, amount });
        self.emit(Transfer { from: owner, to: PRIVATE_ADDRESS_MAGIC_VALUE, amount });
    }

    /// Moves `amount` of the caller's public balance to `to`.
    #[external("public")]
    fn transfer_public(to: AztecAddress, amount: u128) {
        assert(!to.is_zero(), "zero recipient");
        // Only protocol contracts sit off the curve, and none calls this token: a credit there is stranded.
        assert(to.is_valid(), "invalid recipient");
        // `Transfer` to the sentinel would read as a move into private balances.
        assert(to != PRIVATE_ADDRESS_MAGIC_VALUE, "private sentinel recipient");
        assert(amount != 0, "zero amount");
        let from = self.msg_sender();
        self.internal._debit_public(from, amount);
        self.internal._credit_public(to, amount);
        self.emit(Transfer { from, to, amount });
    }

    /// Burns `amount` of `from`'s public balance for the bridge's exit.
    #[external("public")]
    fn burn_public_for_exit(from: AztecAddress, amount: u128) {
        assert(self.msg_sender() == self.storage.config.read().minter, "caller is not minter");
        assert(amount != 0, "zero amount");
        self.internal._debit_public(from, amount);
        self.emit(Transfer { from, to: AztecAddress::zero(), amount });
    }

    #[external("public")]
    #[view]
    fn balance_of_public(owner: AztecAddress) -> u128 {
        self.storage.public_balances.at(owner).read()
    }

    /// Spends `amount` of `owner`'s `label` notes and returns the change, after proving `label` in
    /// the tree of the notes' common origin at the anchor; returns that origin and both roots.
    #[internal("private")]
    fn _checked_debit(owner: AztecAddress, amount: u128, label: Field, path: LabelPath) -> (u8, AnchorRoots) {
        assert(amount != 0, "zero amount");
        let balance = self.storage.private_balances.at(owner);
        let (taken, origin) = balance.try_sub(label, amount);
        assert(taken >= amount, "Balance too low");
        let roots = check_label(self.context, self.storage.config.read().registry, origin, label, path);
        balance.add(label, origin, taken - amount);
        (origin, roots)
    }

    #[internal("public")]
    fn _credit_public(to: AztecAddress, amount: u128) {
        let balance = self.storage.public_balances.at(to);
        balance.write(balance.read() + amount);
    }

    #[internal("public")]
    fn _debit_public(from: AztecAddress, amount: u128) {
        let balance = self.storage.public_balances.at(from);
        let current = balance.read();
        assert(current >= amount, "Balance too low");
        balance.write(current - amount);
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
