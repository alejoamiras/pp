pub mod balance;
pub mod label_note;
mod test;

use aztec::macros::aztec;

#[aztec]
pub contract LabelToken {
    use crate::{balance::LabelBalanceSet, label_note::{LabelNote, PartialLabelNote}};
    use aztec::{
        macros::{functions::{external, initializer, internal, only_self, view}, storage::storage},
        messages::delivery::MessageDelivery,
        protocol::{address::AztecAddress, traits::{FromField, ToField}},
        state_vars::{Map, Owned, PublicImmutable, PublicMutable, StateVariable},
    };

    global MAX_NOTES_PER_SPEND: u32 = 8;

    #[storage]
    struct Storage<Context> {
        minter: PublicImmutable<AztecAddress, Context>,
        balances: Owned<LabelBalanceSet<Context>, Context>,
        public_balances: Map<AztecAddress, PublicMutable<u128, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(minter: AztecAddress) {
        self.storage.minter.initialize(minter);
    }

    /// Mints under `label` with constrained delivery: the recipient's PXE finds it through a handshake, without
    /// having registered the minter.
    #[external("private")]
    fn mint_private(to: AztecAddress, label: Field, amount: u128) {
        assert(self.msg_sender() == self.storage.minter.read(), "caller is not the minter");
        self.storage.balances.at(to).add(label, amount);
    }

    /// Control for `mint_private`: tagged with the address-derived secret, which the recipient's PXE scans only for
    /// senders it knows.
    #[external("private")]
    fn mint_private_address_derived(to: AztecAddress, label: Field, amount: u128) {
        assert(self.msg_sender() == self.storage.minter.read(), "caller is not the minter");
        self.storage.balances.at(to).add_with(
            label,
            amount,
            MessageDelivery::onchain_unconstrained().via_address_derived_secret(),
        );
    }

    /// Spends only notes of `label`; the change keeps the label.
    #[external("private")]
    fn transfer_private(to: AztecAddress, label: Field, amount: u128) {
        let from = self.msg_sender();
        let spent = self.storage.balances.at(from).try_sub(label, amount, MAX_NOTES_PER_SPEND);
        assert(spent >= amount, "balance too low for label");
        self.storage.balances.at(from).add(label, spent - amount);
        self.storage.balances.at(to).add(label, amount);
    }

    #[external("public")]
    fn mint_public(to: AztecAddress, amount: u128) {
        assert(self.msg_sender() == self.storage.minter.read(), "caller is not the minter");
        let balance = self.storage.public_balances.at(to);
        balance.write(balance.read() + amount);
    }

    /// Commits to a note for `owner` under `label`, without an amount. Only `completer` can complete it, once, with
    /// `complete_partial`. Returns the commitment the completer needs.
    #[external("private")]
    fn prepare_partial(owner: AztecAddress, label: Field, completer: AztecAddress) -> Field {
        // A third party must deliver constrained: the owner's PXE does not scan unknown senders' address-derived tags.
        let partial = if self.msg_sender() == owner {
            LabelNote::partial(
                owner,
                label,
                self.context,
                completer,
                MessageDelivery::onchain_unconstrained(),
            )
        } else {
            LabelNote::partial(
                owner,
                label,
                self.context,
                completer,
                MessageDelivery::onchain_constrained(),
            )
        };
        partial.to_field()
    }

    /// Completes `commitment` with `amount` from the caller's public balance. The caller must be the completer.
    #[external("public")]
    fn complete_partial(commitment: Field, amount: u128) {
        let completer = self.msg_sender();
        self.internal._debit_public(completer, amount);
        PartialLabelNote::from_field(commitment).complete(
            self.context,
            completer,
            self.storage.balances.get_storage_slot(),
            amount,
        );
    }

    /// Moves `amount` of the caller's public balance into a private note under `label`, in one transaction.
    #[external("private")]
    fn shield(label: Field, amount: u128) {
        let shielder = self.msg_sender();
        let partial = LabelNote::partial(
            shielder,
            label,
            self.context,
            self.address,
            MessageDelivery::onchain_unconstrained(),
        );
        // The enqueued call's msg_sender is this contract, so the shielder travels as an argument.
        self.enqueue_self._complete_shield(shielder, partial.to_field(), amount);
    }

    #[external("public")]
    #[only_self]
    fn _complete_shield(shielder: AztecAddress, commitment: Field, amount: u128) {
        self.internal._debit_public(shielder, amount);
        PartialLabelNote::from_field(commitment).complete(
            self.context,
            self.address,
            self.storage.balances.get_storage_slot(),
            amount,
        );
    }

    #[internal("public")]
    fn _debit_public(from: AztecAddress, amount: u128) {
        let balance = self.storage.public_balances.at(from);
        balance.write(balance.read() - amount);
    }

    #[external("public")]
    #[view]
    fn balance_of_public(owner: AztecAddress) -> u128 {
        self.storage.public_balances.at(owner).read()
    }

    #[external("utility")]
    unconstrained fn balance_of(owner: AztecAddress, label: Field) -> u128 {
        self.storage.balances.at(owner).balance_of(label)
    }
}
