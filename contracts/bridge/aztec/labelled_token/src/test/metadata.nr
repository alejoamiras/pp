use crate::{LabelledToken, test::utils::{DECIMALS, NAME, setup, SYMBOL}};
use aztec::{protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment};
use compressed_string::FieldCompressedString;

#[test]
unconstrained fn views_match_constructor() {
    let s = setup();
    let t = LabelledToken::at(s.token);
    assert(s.env.view_public(t.name()) == FieldCompressedString::from_string(NAME));
    assert(s.env.view_public(t.symbol()) == FieldCompressedString::from_string(SYMBOL));
    assert(s.env.view_public(t.decimals()) == DECIMALS);
}

#[test(should_fail_with = "zero minter")]
unconstrained fn constructor_failure_zero_minter() {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let init = LabelledToken::interface().constructor(
        NAME,
        SYMBOL,
        DECIMALS,
        AztecAddress::zero(),
        AztecAddress::zero(),
    );
    let _ = env.deploy("LabelledToken").with_public_initializer(admin, init);
}
