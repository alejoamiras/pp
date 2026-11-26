mod test;

// Test-only consumer of `asp_registry::label_check`, wired the way a token is: the registry address is
// fixed at construction. Never deployed outside tests.

use aztec::macros::aztec;

#[aztec]
pub contract AspRegistryProbe {
    use asp_registry::label_check::{AnchorRoots, assert_current, check_label, LabelPath};
    use aztec::{
        macros::{functions::{external, initializer, only_self}, storage::storage},
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

    #[external("private")]
    fn check(origin: u8, label: Field, path: LabelPath) -> AnchorRoots {
        check_label(self.context, self.storage.registry.read(), origin, label, path)
    }

    /// An unshield's shape: the private check, then the public re-check of its roots.
    #[external("private")]
    fn check_then_current(origin: u8, label: Field, path: LabelPath) {
        let roots = check_label(self.context, self.storage.registry.read(), origin, label, path);
        self.enqueue_self._current(roots);
    }

    #[external("public")]
    #[only_self]
    fn _current(roots: AnchorRoots) {
        assert_current(self.context, self.storage.registry.read(), roots);
    }

    /// `assert_current` with caller-chosen roots, for tests of the public check alone.
    #[external("public")]
    fn current(roots: AnchorRoots) {
        assert_current(self.context, self.storage.registry.read(), roots);
    }
}
