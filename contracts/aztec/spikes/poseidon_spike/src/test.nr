use crate::PoseidonSpike;
use aztec::test::helpers::test_environment::TestEnvironment;

#[test]
unconstrained fn harness_deploys_and_calls_private() {
    let mut env = TestEnvironment::new();
    let caller = env.create_light_account();
    let spike = env.deploy("@poseidon_spike/PoseidonSpike").without_initializer();

    let out = env.call_private(caller, PoseidonSpike::at(spike).pool_commitment(1, 2));

    // circomlibjs 0.1.7: Poseidon([1, 2]).
    assert_eq(out, 0x115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a);
}
