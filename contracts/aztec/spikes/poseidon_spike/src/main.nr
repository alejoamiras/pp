mod test;

use aztec::macros::aztec;

#[aztec]
pub contract PoseidonSpike {
    use aztec::macros::functions::external;
    use poseidon::poseidon::bn254::hash_2;

    #[external("private")]
    fn pool_commitment(precommitment: Field, label: Field) -> Field {
        hash_2([precommitment, label])
    }
}
