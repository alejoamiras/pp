use crate::AspRootRegistry::{self, BirthIntakeChanged, PosterChanged, RootPosted, RootRecord};
use crate::test::utils::{current, event_logs, post_at, setup};
use aztec::{
    protocol::{address::AztecAddress, traits::ToField},
    test::helpers::test_environment::TestEnvironment,
};

#[test(should_fail_with = "zero admin")]
unconstrained fn constructor_rejects_zero_admin() {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let _ = env.deploy("AspRootRegistry").with_public_initializer(
        deployer,
        AspRootRegistry::interface().constructor(AztecAddress::zero(), deployer, deployer),
    );
}

#[test(should_fail_with = "Attempted to emit duplicate nullifier")]
unconstrained fn constructor_rejects_second_call() {
    let s = setup();
    s.env.call_public(s.admin, AspRootRegistry::at(s.registry).constructor(s.admin, s.poster, s.intake));
}

#[test(should_fail_with = "not admin")]
unconstrained fn set_poster_rejects_non_admin() {
    let mut s = setup();
    let stranger = s.env.create_light_account();
    s.env.call_public(stranger, AspRootRegistry::at(s.registry).set_poster(stranger));
}

#[test(should_fail_with = "not admin")]
unconstrained fn set_poster_rejects_poster() {
    let s = setup();
    s.env.call_public(s.poster, AspRootRegistry::at(s.registry).set_poster(s.poster));
}

#[test]
unconstrained fn set_poster_resets_record_keeps_sequence() {
    let mut s = setup();
    let next = s.env.create_light_account();
    post_at(s, s.poster, s.t0, 1, 100, s.t0 - 20);
    post_at(s, s.poster, s.t0 + 1, 2, 101, s.t0 - 10);
    s.env.call_public(s.admin, AspRootRegistry::at(s.registry).set_poster(next));
    assert_eq(current(s), RootRecord { sequence: 2, pool_root: 0, birth_root: 0, l1_block: 0, root_time: 0 });
    assert_eq(s.env.view_public(AspRootRegistry::at(s.registry).get_poster()), next);
}

#[test]
unconstrained fn set_poster_recovers_from_max_l1_block() {
    let mut s = setup();
    let next = s.env.create_light_account();
    post_at(s, s.poster, s.t0, 1, 0xffffffffffffffff, s.t0);
    s.env.call_public(s.admin, AspRootRegistry::at(s.registry).set_poster(next));
    post_at(s, next, s.t0 + 1, 2, 100, s.t0);
    assert_eq(current(s).l1_block, 100);
}

#[test(should_fail_with = "not poster")]
unconstrained fn post_root_rejects_replaced_poster() {
    let mut s = setup();
    let next = s.env.create_light_account();
    s.env.call_public(s.admin, AspRootRegistry::at(s.registry).set_poster(next));
    post_at(s, s.poster, s.t0, 1, 100, s.t0);
}

#[test]
unconstrained fn post_root_accepts_new_poster_next_sequence() {
    let mut s = setup();
    let next = s.env.create_light_account();
    post_at(s, s.poster, s.t0, 1, 100, s.t0);
    s.env.call_public(s.admin, AspRootRegistry::at(s.registry).set_poster(next));
    post_at(s, next, s.t0 + 1, 2, 100, s.t0);
    assert_eq(current(s).sequence, 2);
}

#[test(should_fail_with = "not admin")]
unconstrained fn set_birth_intake_rejects_non_admin() {
    let mut s = setup();
    let stranger = s.env.create_light_account();
    s.env.call_public(stranger, AspRootRegistry::at(s.registry).set_birth_intake(stranger));
}

#[test(should_fail_with = "not admin")]
unconstrained fn set_birth_intake_rejects_poster() {
    let s = setup();
    s.env.call_public(s.poster, AspRootRegistry::at(s.registry).set_birth_intake(s.poster));
}

#[test]
unconstrained fn set_birth_intake_updates() {
    let s = setup();
    s.env.call_public(s.admin, AspRootRegistry::at(s.registry).set_birth_intake(AztecAddress::zero()));
    assert_eq(s.env.view_public(AspRootRegistry::at(s.registry).get_birth_intake()), AztecAddress::zero());
}

#[test]
unconstrained fn writes_preserve_admin() {
    let mut s = setup();
    let next = s.env.create_light_account();
    post_at(s, s.poster, s.t0, 1, 100, s.t0);
    s.env.call_public(s.admin, AspRootRegistry::at(s.registry).set_birth_intake(next));
    s.env.call_public(s.admin, AspRootRegistry::at(s.registry).set_poster(next));
    assert_eq(s.env.view_public(AspRootRegistry::at(s.registry).get_admin()), s.admin);
}

#[test]
unconstrained fn set_poster_emits_poster_changed() {
    let s = setup();
    post_at(s, s.poster, s.t0, 1, 100, s.t0);
    // The new poster differs from the caller and the old poster, so the payload shows which it carries.
    s.env.call_public(s.admin, AspRootRegistry::at(s.registry).set_poster(s.intake));
    let logs = event_logs::<PosterChanged, 2>(s);
    assert_eq(logs.len(), 1);
    assert_eq(logs.get(0), [1, s.intake.to_field()]);
    assert_eq(event_logs::<RootPosted, 5>(s).len(), 0);
}

#[test]
unconstrained fn set_birth_intake_emits_birth_intake_changed() {
    let s = setup();
    s.env.call_public(s.admin, AspRootRegistry::at(s.registry).set_birth_intake(s.poster));
    let logs = event_logs::<BirthIntakeChanged, 1>(s);
    assert_eq(logs.len(), 1);
    assert_eq(logs.get(0), [s.poster.to_field()]);
}
