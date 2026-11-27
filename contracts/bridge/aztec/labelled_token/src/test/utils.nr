use crate::LabelledToken;
use asp_registry::{AspRootRegistry, label_check::LabelPath};
use aztec::{protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment};
use bridge_stub::BridgeStub;

pub global NAME: str<31> = "Labelled USD0000000000000000000";
pub global SYMBOL: str<31> = "lUSD000000000000000000000000000";
pub global DECIMALS: u8 = 6;

pub global L: Field = 0x1abe1;
pub global K: Field = 0x2abe1;

pub struct Setup {
    pub env: TestEnvironment,
    pub admin: AztecAddress,
    pub poster: AztecAddress,
    pub user: AztecAddress,
    pub stub: AztecAddress,
    pub registry: AztecAddress,
    pub token: AztecAddress,
}

/// The stub is the minter; the real registry is deployed with nothing posted, `admin` as its admin
/// and birth intake, `poster` as its poster.
pub unconstrained fn setup() -> Setup {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let poster = env.create_light_account();
    let registry = env.deploy("@asp_registry/AspRootRegistry").with_public_initializer(
        admin,
        AspRootRegistry::interface().constructor(admin, poster, admin),
    );
    deploy_token(env, admin, poster, registry)
}

/// As `setup`, but the token points at `registry`, which may be no contract at all.
pub unconstrained fn setup_with_registry(registry: AztecAddress) -> Setup {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    deploy_token(env, admin, AztecAddress::zero(), registry)
}

unconstrained fn deploy_token(
    mut env: TestEnvironment,
    admin: AztecAddress,
    poster: AztecAddress,
    registry: AztecAddress,
) -> Setup {
    let user = env.create_light_account();
    let stub = env.deploy("@bridge_stub/BridgeStub").without_initializer();
    let init = LabelledToken::interface().constructor(NAME, SYMBOL, DECIMALS, stub, registry);
    let token = env.deploy("LabelledToken").with_public_initializer(admin, init);
    Setup { env, admin, poster, user, stub, registry, token }
}

/// A posting time far enough past genesis that any freshness window around it is in the future.
pub unconstrained fn t0(s: Setup) -> u64 {
    s.env.last_block_timestamp() + 100_000
}

/// The poster posts both roots at `now`, as read from an Ethereum block of that time.
pub unconstrained fn post(s: Setup, now: u64, sequence: u64, pool_root: Field, birth_root: Field) {
    s.env.set_next_block_timestamp(now);
    s.env.call_public(
        s.poster,
        AspRootRegistry::at(s.registry).post_root(sequence, pool_root, birth_root, 100 + sequence, now),
    );
}

/// Posts both roots at `t0` and anchors the next private call one second later.
pub unconstrained fn post_now(s: Setup, pool_root: Field, birth_root: Field) {
    let now = t0(s);
    post(s, now, 1, pool_root, birth_root);
    s.env.mine_block_at(now + 1);
}

pub unconstrained fn transfer(
    s: Setup,
    from: AztecAddress,
    to: AztecAddress,
    amount: u128,
    label: Field,
    path: LabelPath,
) {
    s.env.call_private(from, LabelledToken::at(s.token).transfer_private(to, amount, label, path));
}

pub unconstrained fn unshield(s: Setup, from: AztecAddress, amount: u128, label: Field, path: LabelPath) {
    s.env.call_private(from, LabelledToken::at(s.token).unshield(amount, label, path));
}

pub unconstrained fn public_balance(s: Setup, owner: AztecAddress) -> u128 {
    s.env.view_public(LabelledToken::at(s.token).balance_of_public(owner))
}

pub unconstrained fn mint(s: Setup, to: AztecAddress, amount: u128, label: Field) {
    s.env.call_private(s.admin, BridgeStub::at(s.stub).mint(s.token, to, amount, label));
}

pub unconstrained fn ragequit(s: Setup, from: AztecAddress, amount: u128, label: Field) {
    s.env.call_private(from, BridgeStub::at(s.stub).ragequit(s.token, amount, label));
}

pub unconstrained fn labels(s: Setup, owner: AztecAddress) -> BoundedVec<(Field, u8, u128), 16> {
    s.env.execute_utility(LabelledToken::at(s.token).private_balances_by_label(owner, 0))
}

pub unconstrained fn values(
    s: Setup,
    owner: AztecAddress,
    label: Field,
    start: u32,
) -> BoundedVec<u128, 10> {
    s.env.execute_utility(LabelledToken::at(s.token).private_notes_by_label(owner, label, start))
}

pub unconstrained fn balance(s: Setup, owner: AztecAddress) -> u128 {
    s.env.execute_utility(LabelledToken::at(s.token).balance_of_private(owner))
}

/// `owner` holds exactly these `(label, origin, balance)` entries, in this order.
pub unconstrained fn assert_labels<let N: u32>(
    s: Setup,
    owner: AztecAddress,
    want: [(Field, u8, u128); N],
) {
    let got = labels(s, owner);
    assert_eq(got.len(), N);
    for i in 0..N {
        assert(got.get(i) == want[i]);
    }
}
