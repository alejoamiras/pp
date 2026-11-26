use crate::AspRootRegistry::{self, RootRecord};
use aztec::{protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment};

pub global POOL_ROOT: Field = 0x1001;
pub global BIRTH_ROOT: Field = 0x2002;

pub struct Setup {
    pub env: TestEnvironment,
    pub admin: AztecAddress,
    pub poster: AztecAddress,
    pub intake: AztecAddress,
    pub registry: AztecAddress,
    /// A time far enough past genesis that `t0 - MAX_OBSERVATION_LAG` is a valid observation.
    pub t0: u64,
}

pub unconstrained fn setup() -> Setup {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let poster = env.create_light_account();
    let intake = env.create_light_account();
    let registry = env.deploy("AspRootRegistry").with_public_initializer(
        admin,
        AspRootRegistry::interface().constructor(admin, poster, intake),
    );
    let t0 = env.last_block_timestamp() + 100_000;
    Setup { env, admin, poster, intake, registry, t0 }
}

/// Posts `POOL_ROOT` and `BIRTH_ROOT` as `from`, in a block whose timestamp is `now`.
pub unconstrained fn post_at(
    s: Setup,
    from: AztecAddress,
    now: u64,
    sequence: u64,
    l1_block: u64,
    root_time: u64,
) {
    post_roots_at(s, from, now, sequence, POOL_ROOT, BIRTH_ROOT, l1_block, root_time);
}

pub unconstrained fn post_roots_at(
    s: Setup,
    from: AztecAddress,
    now: u64,
    sequence: u64,
    pool_root: Field,
    birth_root: Field,
    l1_block: u64,
    root_time: u64,
) {
    s.env.set_next_block_timestamp(now);
    s.env.call_public(
        from,
        AspRootRegistry::at(s.registry).post_root(sequence, pool_root, birth_root, l1_block, root_time),
    );
}

pub unconstrained fn current(s: Setup) -> RootRecord {
    s.env.view_public(AspRootRegistry::at(s.registry).get_current())
}
