use crate::LabelledToken;
use aztec::{protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment};

pub global NAME: str<31> = "Labelled USD0000000000000000000";
pub global SYMBOL: str<31> = "lUSD000000000000000000000000000";
pub global DECIMALS: u8 = 6;

pub struct Setup {
    pub env: TestEnvironment,
    pub admin: AztecAddress,
    pub minter: AztecAddress,
    pub token: AztecAddress,
}

/// Deploys the token with `minter` and no registry, as a stage-A generation.
pub unconstrained fn setup() -> Setup {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let minter = env.create_light_account();
    let init = LabelledToken::interface().constructor(
        NAME,
        SYMBOL,
        DECIMALS,
        minter,
        AztecAddress::zero(),
    );
    let token = env.deploy("LabelledToken").with_public_initializer(admin, init);
    Setup { env, admin, minter, token }
}
