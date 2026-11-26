use crate::AspRegistryProbe;
use crate::test::{post, setup, Setup};
use asp_registry::label_check::{
    AnchorRoots, check_label, LabelPath, MAX_ROOT_AGE, ORIGIN_BIRTH, ORIGIN_POOL, SPEND_WINDOW, TreeRoot,
};
use aztec::test::helpers::test_environment::PrivateContextOptions;
use pp_hash::{hash_1, hash_2, MAX_DEPTH};

global POOL_LABELS: [Field; 4] = [0x11, 0x12, 0x13, 0x14];
global BIRTH_LABELS: [Field; 4] = [0x21, 0x22, 0x23, 0x24];

/// A four-leaf LeanIMT over `hash_1([label])`: its root and the path to leaf `i`.
fn tree4(labels: [Field; 4], i: u32) -> (Field, LabelPath) {
    let h = labels.map(|label| hash_1([label]));
    let pairs = [hash_2([h[0], h[1]]), hash_2([h[2], h[3]])];
    let mut siblings = [0; MAX_DEPTH];
    siblings[0] = h[i ^ 1];
    siblings[1] = pairs[(i >> 1) ^ 1];
    (hash_2(pairs), LabelPath { index: i, depth: 2, siblings })
}

/// Posts both four-leaf trees as the current roots.
unconstrained fn post_trees(s: Setup, now: u64, sequence: u64) -> (Field, Field) {
    let pool_root = tree4(POOL_LABELS, 0).0;
    let birth_root = tree4(BIRTH_LABELS, 0).0;
    post(s, now, sequence, pool_root, birth_root);
    (pool_root, birth_root)
}

unconstrained fn check(s: Setup, origin: u8, label: Field, path: LabelPath) -> AnchorRoots {
    s.env.call_private(s.admin, AspRegistryProbe::at(s.probe).check(origin, label, path))
}

#[test]
unconstrained fn check_accepts_pool_path() {
    let s = setup();
    let (pool_root, birth_root) = post_trees(s, s.t0, 1);
    s.env.mine_block_at(s.t0 + 1);
    let roots = check(s, ORIGIN_POOL, POOL_LABELS[2], tree4(POOL_LABELS, 2).1);
    assert_eq(
        roots,
        AnchorRoots { pool: TreeRoot { root: pool_root, time: s.t0 }, birth: TreeRoot { root: birth_root, time: s.t0 } },
    );
}

#[test]
unconstrained fn check_accepts_birth_path() {
    let s = setup();
    let _ = post_trees(s, s.t0, 1);
    s.env.mine_block_at(s.t0 + 1);
    let _ = check(s, ORIGIN_BIRTH, BIRTH_LABELS[1], tree4(BIRTH_LABELS, 1).1);
}

#[test]
unconstrained fn check_accepts_spec_vector_path() {
    // `spike_deep_first` in packages/bridge-spec/vectors/v1.json, generated with @zk-kit/lean-imt.
    let label = 0x000000000000000000000000000000000000000027e41b3246bec9b16e398115;
    let root = 0x2ad4f687b3ba533fc05c3d3722ce1db5592af0561d40ff24505d86dd3119ffdd;
    let siblings = [
        0x0904609b9f95cbe482038bed9c5d139ed2d1ad937bf015c4d4b129ca145929da,
        0x1c0594e6b9d5c137783d38516ba87ac596bfeeb05a0fb9326753aad1406e03ee,
        0x2092a3f868ff8f5dbbd76ec36d01cb90f83eee595cdede3b1e2abb74f75f5ff7,
        0x0b066886380695e4d3b055d26456d6cae1f88f0356d500aebef6c5b1318a0509,
        0x29cd782a2b848bfa1f68737df346fac9058a2c7a0089eabfb867200c34f3cc13,
        0x14b18ad1f90aa19ff95a76a1ea33f87755cbc4f869c96a6dcb7652c3707896d1,
        0x1dc2304a49d2a380e4cea388698839df58397a166864598f73411fe9e0a607d4,
        0x071ffe34bdfd496daf1e04f77e2d51d047d9e3f279267ffdaa02a3d831457a17,
        0x278d1a7d6bd3d6e5ca0a082f2ffabf9e77b5daf405d9ea8150ab286c569e9626,
        0x1183a69dd1f5ac068e301a96fb65a349bb1dc869d35cc32bc3bf17d1fe3ac0e3,
        0x174150060c7b85b7e62ba729f0ae38939128e3efa35e1a43310d316aaf12c679,
        0x05525fc42b746cc2a60ce825b823817076e23df1045e67283db77c1ad0fb89b1,
        0x2e0a0bf0e9b3f7a2467e06e2d03e00db38afe8da528aeca2f9d1e0e1fbee03f5,
        0x2bbbde17feffb0555ec1d21fe3b37cff69ff3c6e405ff2e6e419dadc2d988537,
        0x0b0f285aab66114d770d83048d35f24eead76ae42a083b954ff2ce517bfe2c36,
        0x02a2889bab5d1da2b593034cfecea6c5e081fe18f7df2832a61ca26e1d3ebbe9,
        0x23d2b8d2bee56df8cb52df746c56dcaba7f147d282e0690795256025c8b159b3,
        0x20dda15ebef32992b6d2c2c5ed26993bf2f5c7fb79d52919359629f2971b506a,
    ];
    let s = setup();
    post(s, s.t0, 1, root, 0);
    s.env.mine_block_at(s.t0 + 1);
    let roots = check(s, ORIGIN_POOL, label, LabelPath { index: 0, depth: 18, siblings });
    assert_eq(roots.pool.root, root);
}

#[test]
unconstrained fn check_accepts_promoted_leaf() {
    // Three leaves: the third has no right sibling, so it rises unhashed and its path has one level.
    let h = POOL_LABELS.map(|label| hash_1([label]));
    let left = hash_2([h[0], h[1]]);
    let mut siblings = [0; MAX_DEPTH];
    siblings[0] = left;
    let s = setup();
    post(s, s.t0, 1, hash_2([left, h[2]]), 0);
    s.env.mine_block_at(s.t0 + 1);
    let _ = check(s, ORIGIN_POOL, POOL_LABELS[2], LabelPath { index: 1, depth: 1, siblings });
}

#[test(should_fail_with = "NotMember")]
unconstrained fn check_rejects_wrong_sibling() {
    let s = setup();
    let _ = post_trees(s, s.t0, 1);
    s.env.mine_block_at(s.t0 + 1);
    let mut path = tree4(POOL_LABELS, 2).1;
    path.siblings[1] += 1;
    let _ = check(s, ORIGIN_POOL, POOL_LABELS[2], path);
}

#[test(should_fail_with = "NotMember")]
unconstrained fn check_rejects_wrong_label() {
    let s = setup();
    let _ = post_trees(s, s.t0, 1);
    s.env.mine_block_at(s.t0 + 1);
    let _ = check(s, ORIGIN_POOL, POOL_LABELS[3], tree4(POOL_LABELS, 2).1);
}

#[test(should_fail_with = "NotMember")]
unconstrained fn check_rejects_birth_path_for_pool_origin() {
    let s = setup();
    let _ = post_trees(s, s.t0, 1);
    s.env.mine_block_at(s.t0 + 1);
    let _ = check(s, ORIGIN_POOL, BIRTH_LABELS[1], tree4(BIRTH_LABELS, 1).1);
}

#[test(should_fail_with = "NotMember")]
unconstrained fn check_rejects_pool_path_for_birth_origin() {
    let s = setup();
    let _ = post_trees(s, s.t0, 1);
    s.env.mine_block_at(s.t0 + 1);
    let _ = check(s, ORIGIN_BIRTH, POOL_LABELS[1], tree4(POOL_LABELS, 1).1);
}

#[test(should_fail_with = "SiblingOutOfRange")]
unconstrained fn check_rejects_nonzero_padding() {
    let s = setup();
    let _ = post_trees(s, s.t0, 1);
    s.env.mine_block_at(s.t0 + 1);
    let mut path = tree4(POOL_LABELS, 2).1;
    path.siblings[2] = 1;
    let _ = check(s, ORIGIN_POOL, POOL_LABELS[2], path);
}

#[test(should_fail_with = "root too old")]
unconstrained fn check_rejects_stale_root() {
    let s = setup();
    let _ = post_trees(s, s.t0, 1);
    s.env.mine_block_at(s.t0 + MAX_ROOT_AGE - SPEND_WINDOW + 1);
    let _ = check(s, ORIGIN_POOL, POOL_LABELS[2], tree4(POOL_LABELS, 2).1);
}

#[test]
unconstrained fn check_uses_anchor_record_not_current() {
    let s = setup();
    let (pool_root, _) = post_trees(s, s.t0, 1);
    let anchor = s.env.last_block_number();
    post(s, s.t0 + 1, 2, 0xdead, 0);
    s.env.mine_block_at(s.t0 + 2);
    let roots = s.env.private_context_opts(
        PrivateContextOptions::new().at_anchor_block_number(anchor),
        |context| check_label(context, s.registry, ORIGIN_POOL, POOL_LABELS[2], tree4(POOL_LABELS, 2).1),
    );
    assert_eq(roots.pool.root, pool_root);
}

#[test]
unconstrained fn check_then_current_accepts_unchanged() {
    let s = setup();
    let _ = post_trees(s, s.t0, 1);
    s.env.mine_block_at(s.t0 + 1);
    s.env.call_private(
        s.admin,
        AspRegistryProbe::at(s.probe).check_then_current(ORIGIN_POOL, POOL_LABELS[2], tree4(POOL_LABELS, 2).1),
    );
}

#[test(should_fail_with = "roots changed")]
unconstrained fn check_then_current_rejects_changed_root() {
    // TXE proves at its latest block, so the change lands between the private check and the public
    // step; the network suite shows the same inside one transaction.
    let s = setup();
    let _ = post_trees(s, s.t0, 1);
    s.env.mine_block_at(s.t0 + 1);
    let roots = s.env.private_context(|context| {
        check_label(context, s.registry, ORIGIN_POOL, POOL_LABELS[2], tree4(POOL_LABELS, 2).1)
    });
    post(s, s.t0 + 2, 2, 0xdead, roots.birth.root);
    s.env.set_next_block_timestamp(s.t0 + 3);
    s.env.call_public(s.admin, AspRegistryProbe::at(s.probe).current(roots));
}
