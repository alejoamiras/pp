use crate::AspRootRegistry::{self, RootRecord};
use aztec::{
    event::event_interface::EventInterface,
    ephemeral::EphemeralArray,
    oracle::message_processing::get_tx_effects,
    protocol::{
        address::AztecAddress,
        constants::{DOM_SEP__EVENT_LOG_TAG, PUBLIC_LOG_HEADER_LENGTH},
        hash::compute_log_tag,
        traits::ToField,
    },
    test::helpers::{test_environment::TestEnvironment, txe_oracles::get_last_tx_effects},
};

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

/// The payload of each `Event` log this registry emitted in the last transaction, in order.
pub unconstrained fn event_logs<Event, let N: u32>(s: Setup) -> BoundedVec<[Field; N], 4>
where
    Event: EventInterface,
{
    let tx_hash = get_last_tx_effects().tx_hash;
    // The plural oracle: TXE 6.0.0 serves `getTxEffects` but not `getTxEffect`.
    let logs = s.env.utility_context(|_| get_tx_effects(EphemeralArray::from_array([tx_hash])).get(0))
        .unwrap()
        .public_logs;
    let tag = compute_log_tag(Event::get_event_type_id().to_field(), DOM_SEP__EVENT_LOG_TAG);
    let mut found = BoundedVec::new();
    let mut i = 0;
    // Each log is `[length, contract address, tag, fields...]`; `length` counts the tag and fields.
    while i < logs.length {
        let length = logs.payload[i] as u32;
        if (logs.payload[i + 1] == s.registry.to_field()) & (logs.payload[i + 2] == tag) {
            assert_eq(length, N + 1);
            let mut fields = [0; N];
            for k in 0..N {
                fields[k] = logs.payload[i + 3 + k];
            }
            found.push(fields);
        }
        i += PUBLIC_LOG_HEADER_LENGTH + length;
    }
    assert_eq(i, logs.length);
    found
}
