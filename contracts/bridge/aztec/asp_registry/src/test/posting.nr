use crate::AspRootRegistry::{self, ListSizes, RootPosted, RootRecord};
use crate::label_check::MAX_OBSERVATION_LAG;
use crate::test::utils::{
    BIRTH_ROOT, current, event_logs, POOL_ROOT, post_at, post_roots_at, post_sized_at, raw_sizes, setup, sizes,
};

// 2^18, the deepest tree a label path proves membership in.
global MAX_SIZE: u32 = 262144;

#[test]
unconstrained fn post_root_accepts_first_post() {
    let s = setup();
    post_at(s, s.poster, s.t0, 1, 100, s.t0 - 10);
    assert_eq(
        current(s),
        RootRecord { sequence: 1, pool_root: POOL_ROOT, birth_root: BIRTH_ROOT, l1_block: 100, root_time: s.t0 - 10 },
    );
}

#[test(should_fail_with = "not poster")]
unconstrained fn post_root_rejects_non_poster() {
    let mut s = setup();
    let stranger = s.env.create_light_account();
    post_at(s, stranger, s.t0, 1, 100, s.t0);
}

#[test(should_fail_with = "not poster")]
unconstrained fn post_root_rejects_admin_not_poster() {
    let s = setup();
    post_at(s, s.admin, s.t0, 1, 100, s.t0);
}

#[test(should_fail_with = "sequence not next")]
unconstrained fn post_root_rejects_sequence_gap() {
    let s = setup();
    post_at(s, s.poster, s.t0, 2, 100, s.t0);
}

#[test(should_fail_with = "sequence not next")]
unconstrained fn post_root_rejects_repeated_sequence() {
    let s = setup();
    post_at(s, s.poster, s.t0, 1, 100, s.t0);
    post_at(s, s.poster, s.t0 + 1, 1, 101, s.t0 + 1);
}

#[test(should_fail_with = "zero pool root")]
unconstrained fn post_root_rejects_zero_pool_root() {
    let s = setup();
    post_roots_at(s, s.poster, s.t0, 1, 0, BIRTH_ROOT, 100, s.t0);
}

#[test]
unconstrained fn post_root_accepts_zero_birth_root() {
    let s = setup();
    post_roots_at(s, s.poster, s.t0, 1, POOL_ROOT, 0, 100, s.t0);
    assert_eq(current(s).birth_root, 0);
    assert_eq(sizes(s).birth, 0);
}

#[test]
unconstrained fn post_root_stores_sizes() {
    let s = setup();
    post_sized_at(s, s.poster, s.t0, 1, POOL_ROOT, BIRTH_ROOT, 100, s.t0, 5, 4);
    assert_eq(sizes(s), ListSizes { pool: 5, birth: 4 });
    assert_eq(raw_sizes(s), [5, 4]);
}

#[test]
unconstrained fn post_root_replaces_sizes() {
    let s = setup();
    post_sized_at(s, s.poster, s.t0, 1, POOL_ROOT, BIRTH_ROOT, 100, s.t0, 5, 4);
    post_sized_at(s, s.poster, s.t0 + 1, 2, POOL_ROOT + 1, 0, 101, s.t0 + 1, 4, 0);
    assert_eq(sizes(s), ListSizes { pool: 4, birth: 0 });
}

#[test]
unconstrained fn post_root_accepts_sizes_at_limit() {
    let s = setup();
    post_sized_at(s, s.poster, s.t0, 1, POOL_ROOT, BIRTH_ROOT, 100, s.t0, MAX_SIZE, MAX_SIZE);
    assert_eq(sizes(s), ListSizes { pool: MAX_SIZE, birth: MAX_SIZE });
}

#[test(should_fail_with = "zero pool size")]
unconstrained fn post_root_rejects_zero_pool_size() {
    let s = setup();
    post_sized_at(s, s.poster, s.t0, 1, POOL_ROOT, BIRTH_ROOT, 100, s.t0, 0, 4);
}

#[test(should_fail_with = "birth size and root disagree")]
unconstrained fn post_root_rejects_birth_size_without_root() {
    let s = setup();
    post_sized_at(s, s.poster, s.t0, 1, POOL_ROOT, 0, 100, s.t0, 5, 1);
}

#[test(should_fail_with = "birth size and root disagree")]
unconstrained fn post_root_rejects_birth_root_without_size() {
    let s = setup();
    post_sized_at(s, s.poster, s.t0, 1, POOL_ROOT, BIRTH_ROOT, 100, s.t0, 5, 0);
}

#[test(should_fail_with = "size too large")]
unconstrained fn post_root_rejects_pool_size_past_limit() {
    let s = setup();
    post_sized_at(s, s.poster, s.t0, 1, POOL_ROOT, BIRTH_ROOT, 100, s.t0, MAX_SIZE + 1, 4);
}

#[test(should_fail_with = "size too large")]
unconstrained fn post_root_rejects_birth_size_past_limit() {
    let s = setup();
    post_sized_at(s, s.poster, s.t0, 1, POOL_ROOT, BIRTH_ROOT, 100, s.t0, 5, MAX_SIZE + 1);
}

#[test(should_fail_with = "l1 block regressed")]
unconstrained fn post_root_rejects_l1_block_regression() {
    let s = setup();
    post_at(s, s.poster, s.t0, 1, 100, s.t0 - 20);
    post_at(s, s.poster, s.t0 + 1, 2, 99, s.t0);
}

#[test]
unconstrained fn post_root_accepts_repeated_block_same_time() {
    let s = setup();
    post_at(s, s.poster, s.t0, 1, 100, s.t0 - 20);
    post_at(s, s.poster, s.t0 + 300, 2, 100, s.t0 - 20);
    assert_eq(current(s).sequence, 2);
}

#[test(should_fail_with = "new time on same block")]
unconstrained fn post_root_rejects_repeated_block_new_time() {
    let s = setup();
    post_at(s, s.poster, s.t0, 1, 100, s.t0 - 20);
    post_at(s, s.poster, s.t0 + 300, 2, 100, s.t0 + 280);
}

#[test]
unconstrained fn post_root_accepts_equal_root_time_new_block() {
    let s = setup();
    post_at(s, s.poster, s.t0, 1, 100, s.t0 - 20);
    post_at(s, s.poster, s.t0 + 1, 2, 101, s.t0 - 20);
    assert_eq(current(s).l1_block, 101);
}

#[test(should_fail_with = "root time regressed")]
unconstrained fn post_root_rejects_root_time_regression() {
    let s = setup();
    post_at(s, s.poster, s.t0, 1, 100, s.t0 - 20);
    post_at(s, s.poster, s.t0 + 1, 2, 101, s.t0 - 21);
}

#[test]
unconstrained fn post_root_accepts_root_time_now() {
    let s = setup();
    post_at(s, s.poster, s.t0, 1, 100, s.t0);
    assert_eq(current(s).root_time, s.t0);
}

#[test(should_fail_with = "root time in the future")]
unconstrained fn post_root_rejects_future_root_time() {
    let s = setup();
    post_at(s, s.poster, s.t0, 1, 100, s.t0 + 1);
}

#[test]
unconstrained fn post_root_accepts_lag_at_limit() {
    let s = setup();
    post_at(s, s.poster, s.t0, 1, 100, s.t0 - MAX_OBSERVATION_LAG);
    assert_eq(current(s).root_time, s.t0 - MAX_OBSERVATION_LAG);
}

#[test(should_fail_with = "observation too old")]
unconstrained fn post_root_rejects_lag_past_limit() {
    let s = setup();
    post_at(s, s.poster, s.t0, 1, 100, s.t0 - MAX_OBSERVATION_LAG - 1);
}

#[test]
unconstrained fn views_return_constructor_values() {
    let s = setup();
    let r = AspRootRegistry::at(s.registry);
    assert_eq(s.env.view_public(r.get_admin()), s.admin);
    assert_eq(s.env.view_public(r.get_poster()), s.poster);
    assert_eq(s.env.view_public(r.get_birth_intake()), s.intake);
    assert_eq(current(s), RootRecord { sequence: 0, pool_root: 0, birth_root: 0, l1_block: 0, root_time: 0 });
    assert_eq(sizes(s), ListSizes { pool: 0, birth: 0 });
}

#[test]
unconstrained fn post_root_emits_root_posted() {
    let s = setup();
    post_sized_at(s, s.poster, s.t0, 1, 0xa1, 0xb2, 0xc3, s.t0 - 4, 7, 6);
    let logs = event_logs::<RootPosted, 7>(s);
    assert_eq(logs.len(), 1);
    // Literal fields, so a reordered event declaration fails here instead of changing both sides.
    assert_eq(logs.get(0), [1, 0xa1, 0xb2, 0xc3, (s.t0 - 4) as Field, 7, 6]);
}
