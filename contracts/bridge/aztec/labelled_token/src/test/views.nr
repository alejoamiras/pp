use crate::{
    LabelledToken,
    note::ORIGIN_POOL,
    test::utils::{assert_labels, balance, K, L, mint, ragequit, setup, values},
};

#[test]
unconstrained fn balance_of_private_sums_labels() {
    let s = setup();
    mint(s, s.user, 10, L);
    mint(s, s.user, 20, K);
    assert_eq(balance(s, s.user), 30);
}

// Twelve notes span two note pages; the totals must include both.
#[test]
unconstrained fn private_balances_by_label_aggregates_pages() {
    let s = setup();
    let m: Field = 0x3abe1;
    for i in 0..12 {
        let label = if i % 3 == 0 {
            L
        } else if i % 3 == 1 {
            K
        } else {
            m
        };
        mint(s, s.user, 10, label);
    }
    let all = crate::test::utils::labels(s, s.user);
    assert_eq(all.len(), 3);
    let mut total = 0 as u128;
    for i in 0..3 {
        let (_, origin, sum) = all.get(i);
        assert_eq(origin, ORIGIN_POOL);
        assert_eq(sum, 40);
        total += sum;
    }
    assert_eq(total, 120);
    let rest =
        s.env.execute_utility(LabelledToken::at(s.token).private_balances_by_label(s.user, 1));
    assert_eq(rest.len(), 2);
    assert(rest.get(0) == all.get(1));
}

#[test]
unconstrained fn private_notes_by_label_descending_one_page() {
    let s = setup();
    for v in 1..13 {
        mint(s, s.user, v as u128, L);
    }
    mint(s, s.user, 100, K);
    let first = values(s, s.user, L, 0);
    assert_eq(first.len(), 10);
    for i in 0..10 {
        assert_eq(first.get(i), (12 - i) as u128);
    }
    let second = values(s, s.user, L, 10);
    assert_eq(second.len(), 2);
    assert_eq(second.get(0), 2);
    assert_eq(second.get(1), 1);
}

// Every step changes one label and leaves the other's sum untouched.
#[test]
unconstrained fn per_label_sums_conserved() {
    let s = setup();
    mint(s, s.user, 50, L);
    mint(s, s.user, 30, K);
    assert_labels(s, s.user, [(L, ORIGIN_POOL, 50), (K, ORIGIN_POOL, 30)]);
    ragequit(s, s.user, 20, L);
    assert_labels(s, s.user, [(K, ORIGIN_POOL, 30), (L, ORIGIN_POOL, 30)]);
    mint(s, s.user, 5, L);
    ragequit(s, s.user, 30, K);
    assert_labels(s, s.user, [(L, ORIGIN_POOL, 35)]);
}
