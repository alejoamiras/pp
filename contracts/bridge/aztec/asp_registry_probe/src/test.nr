use crate::AspRegistryProbe;
use asp_registry::{
    AspRootRegistry,
    label_check::{AnchorRoots, MAX_ROOT_AGE, TreeRoot},
};
use aztec::{protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment};

global POOL_A: Field = 0xa1;
global POOL_B: Field = 0xa2;
global BIRTH_A: Field = 0xb1;
global BIRTH_B: Field = 0xb2;

pub struct Setup {
    pub env: TestEnvironment,
    pub admin: AztecAddress,
    pub poster: AztecAddress,
    pub registry: AztecAddress,
    pub probe: AztecAddress,
    pub t0: u64,
}

unconstrained fn setup() -> Setup {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let poster = env.create_light_account();
    let registry = env.deploy("@asp_registry/AspRootRegistry").with_public_initializer(
        admin,
        AspRootRegistry::interface().constructor(admin, poster, admin),
    );
    let probe = env.deploy("AspRegistryProbe").with_public_initializer(
        admin,
        AspRegistryProbe::interface().constructor(registry),
    );
    let t0 = env.last_block_timestamp() + 100_000;
    Setup { env, admin, poster, registry, probe, t0 }
}

unconstrained fn post(s: Setup, now: u64, sequence: u64, pool_root: Field, birth_root: Field) {
    s.env.set_next_block_timestamp(now);
    s.env.call_public(
        s.poster,
        AspRootRegistry::at(s.registry).post_root(sequence, pool_root, birth_root, 100 + sequence, now),
    );
}

unconstrained fn roots(pool_root: Field, birth_root: Field) -> AnchorRoots {
    AnchorRoots { pool: TreeRoot { root: pool_root, time: 0 }, birth: TreeRoot { root: birth_root, time: 0 } }
}

unconstrained fn check_at(s: Setup, now: u64, expected: AnchorRoots) {
    s.env.set_next_block_timestamp(now);
    s.env.call_public(s.admin, AspRegistryProbe::at(s.probe).current(expected));
}

#[test]
unconstrained fn assert_current_accepts_unchanged() {
    let s = setup();
    post(s, s.t0, 1, POOL_A, BIRTH_A);
    check_at(s, s.t0 + 1, roots(POOL_A, BIRTH_A));
}

#[test]
unconstrained fn assert_current_accepts_identical_repost() {
    let s = setup();
    post(s, s.t0, 1, POOL_A, BIRTH_A);
    s.env.set_next_block_timestamp(s.t0 + 300);
    s.env.call_public(
        s.poster,
        AspRootRegistry::at(s.registry).post_root(2, POOL_A, BIRTH_A, 101, s.t0),
    );
    check_at(s, s.t0 + 301, roots(POOL_A, BIRTH_A));
}

#[test]
unconstrained fn assert_current_accepts_restored_pair() {
    let s = setup();
    post(s, s.t0, 1, POOL_A, BIRTH_A);
    post(s, s.t0 + 1, 2, POOL_B, BIRTH_A);
    post(s, s.t0 + 2, 3, POOL_A, BIRTH_A);
    check_at(s, s.t0 + 3, roots(POOL_A, BIRTH_A));
}

#[test(should_fail_with = "roots changed")]
unconstrained fn assert_current_rejects_pool_root_change() {
    let s = setup();
    post(s, s.t0, 1, POOL_A, BIRTH_A);
    post(s, s.t0 + 1, 2, POOL_B, BIRTH_A);
    check_at(s, s.t0 + 2, roots(POOL_A, BIRTH_A));
}

#[test(should_fail_with = "roots changed")]
unconstrained fn assert_current_rejects_birth_root_change() {
    let s = setup();
    post(s, s.t0, 1, POOL_A, BIRTH_A);
    post(s, s.t0 + 1, 2, POOL_A, BIRTH_B);
    check_at(s, s.t0 + 2, roots(POOL_A, BIRTH_A));
}

#[test(should_fail_with = "roots changed")]
unconstrained fn assert_current_rejects_after_rotation() {
    let s = setup();
    post(s, s.t0, 1, POOL_A, BIRTH_A);
    s.env.set_next_block_timestamp(s.t0 + 1);
    s.env.call_public(s.admin, AspRootRegistry::at(s.registry).set_poster(s.poster));
    check_at(s, s.t0 + 2, roots(POOL_A, BIRTH_A));
}

#[test]
unconstrained fn assert_current_accepts_age_at_limit() {
    let s = setup();
    post(s, s.t0, 1, POOL_A, BIRTH_A);
    check_at(s, s.t0 + MAX_ROOT_AGE, roots(POOL_A, BIRTH_A));
}

#[test(should_fail_with = "current root too old")]
unconstrained fn assert_current_rejects_age_past_limit() {
    let s = setup();
    post(s, s.t0, 1, POOL_A, BIRTH_A);
    check_at(s, s.t0 + MAX_ROOT_AGE + 1, roots(POOL_A, BIRTH_A));
}
