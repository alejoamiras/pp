pub mod balance;
pub mod label_note;
mod test;

use aztec::macros::aztec;

#[aztec]
pub contract LabelToken {
    use crate::balance::LabelBalanceSet;
    use aztec::{
        macros::{functions::{external, initializer}, storage::storage},
        messages::delivery::MessageDelivery,
        protocol::address::AztecAddress,
        state_vars::{Owned, PublicImmutable},
    };

    global MAX_NOTES_PER_SPEND: u32 = 8;

    #[storage]
    struct Storage<Context> {
        minter: PublicImmutable<AztecAddress, Context>,
        balances: Owned<LabelBalanceSet<Context>, Context>,
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

    #[external("utility")]
    unconstrained fn balance_of(owner: AztecAddress, label: Field) -> u128 {
        self.storage.balances.at(owner).balance_of(label)
    }
}
