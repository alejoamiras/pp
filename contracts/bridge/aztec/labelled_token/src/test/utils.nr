use crate::LabelledToken;
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
    pub user: AztecAddress,
    pub stub: AztecAddress,
    pub token: AztecAddress,
}

/// A stage-A generation: the stub is the minter and the token has no registry.
pub unconstrained fn setup() -> Setup {
    setup_with_registry(AztecAddress::zero())
}

pub unconstrained fn setup_with_registry(registry: AztecAddress) -> Setup {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let user = env.create_light_account();
    let stub = env.deploy("@bridge_stub/BridgeStub").without_initializer();
    let init = LabelledToken::interface().constructor(NAME, SYMBOL, DECIMALS, stub, registry);
    let token = env.deploy("LabelledToken").with_public_initializer(admin, init);
    Setup { env, admin, user, stub, token }
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
