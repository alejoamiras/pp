use crate::RegistryReader;
use aztec::{protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment};
use root_registry::RootRegistry;

global MAX_AGE: u64 = 3600;
global WINDOW: u64 = 1800;
global ROOT_1: Field = 0xabc;
global ROOT_2: Field = 0xdef;

unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();
    let owner = env.create_light_account();
    let registry = env.deploy("@root_registry/RootRegistry").with_public_initializer(
        owner,
        RootRegistry::interface().constructor(owner),
    );
    let reader = env.deploy("@registry_reader/RegistryReader").with_public_initializer(
        owner,
        RegistryReader::interface().constructor(registry, MAX_AGE, WINDOW),
    );
    (env, owner, registry, reader)
}

/// Posts, then mines one block whose timestamp is `post time + offset`, which becomes the next call's anchor.
unconstrained fn post_then_anchor_at(
    env: TestEnvironment,
    owner: AztecAddress,
    registry: AztecAddress,
    offset: u64,
) -> u64 {
    env.call_public(owner, RootRegistry::at(registry).post_root(1, ROOT_1));
    let posted_at = env.last_block_timestamp();
    env.mine_block_at(posted_at + offset);
    posted_at
}

#[test]
unconstrained fn historical_reads_equal_the_posted_record() {
    let (env, owner, registry, reader) = setup();
    let posted_at = post_then_anchor_at(env, owner, registry, 1);
    let read = env.call_private(owner, RegistryReader::at(reader).check());
    assert_eq(read, env.view_public(RootRegistry::at(registry).get_record()));
    assert_eq(read.sequence, 1);
    assert_eq(read.root, ROOT_1);
    assert_eq(read.time, posted_at);
}

#[test]
unconstrained fn freshness_passes_at_equality() {
    let (env, owner, registry, reader) = setup();
    let _ = post_then_anchor_at(env, owner, registry, MAX_AGE - WINDOW);
    let _ = env.call_private(owner, RegistryReader::at(reader).check());
}

#[test(should_fail_with = "root too old")]
unconstrained fn check_failure_one_second_past_freshness() {
    let (env, owner, registry, reader) = setup();
    let _ = post_then_anchor_at(env, owner, registry, MAX_AGE - WINDOW + 1);
    let _ = env.call_private(owner, RegistryReader::at(reader).check());
}

#[test(should_fail_with = "registry empty")]
unconstrained fn check_failure_empty_registry() {
    let (env, owner, _registry, reader) = setup();
    let _ = env.call_private(owner, RegistryReader::at(reader).check());
}

#[test(should_fail_with = "sequence not increasing")]
unconstrained fn post_failure_stale_sequence() {
    let (env, owner, registry, _reader) = setup();
    env.call_public(owner, RootRegistry::at(registry).post_root(2, ROOT_2));
    env.call_public(owner, RootRegistry::at(registry).post_root(1, ROOT_1));
}

#[test(should_fail_with = "zero root")]
unconstrained fn post_failure_zero_root() {
    let (env, owner, registry, _reader) = setup();
    env.call_public(owner, RootRegistry::at(registry).post_root(1, 0));
}

#[test]
unconstrained fn check_current_passes_when_unchanged() {
    let (env, owner, registry, reader) = setup();
    let _ = post_then_anchor_at(env, owner, registry, 1);
    let read = env.call_private(owner, RegistryReader::at(reader).check_current());
    assert_eq(read.sequence, 1);
}
