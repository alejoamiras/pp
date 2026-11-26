mod test;

// Test-only consumer of `asp_registry::label_check`, wired the way a token is: the registry address is
// fixed at construction. Never deployed outside tests.

use aztec::macros::aztec;

#[aztec]
pub contract AspRegistryProbe {
    use asp_registry::label_check::{AnchorRoots, assert_current};
    use aztec::{
        macros::{functions::{external, initializer}, storage::storage},
        protocol::address::AztecAddress,
        state_vars::PublicImmutable,
    };

    #[storage]
    struct Storage<Context> {
        registry: PublicImmutable<AztecAddress, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(registry: AztecAddress) {
        self.storage.registry.initialize(registry);
    }

    #[external("public")]
    fn current(roots: AnchorRoots) {
        assert_current(self.context, self.storage.registry.read(), roots);
    }
}
