# pp_hash

The pool's circom Poseidon (`hash_1`, `hash_2`), LeanIMT membership in `@zk-kit/lean-imt`'s proof
format (`LabelPath`, `lean_imt_root`, `assert_lean_imt_member`) and the birth hashes of Aztec-born
labels (`birth::{birth_label, birth_nullifier, birth_id}`). `@pp/bridge-spec` is the TS mirror;
keystone checks this crate against its generated vectors, and `src/test.nr` holds the crate's own
cases. The wire-format README in `packages/bridge-spec` is normative.

## Pins

- aztec-nr v6.0.0, spelled exactly as every crate spells it, so `LabelPath`'s `Serialize` and
  `Deserialize` are the traits a contract argument needs.
- noir-lang/poseidon v0.3.0, the tag aztec-nr pins; its bn254 sources equal v0.4.0's (which
  protocol_types pins). Nargo has no lockfile, so `contracts/crates.json` records the commit the tag
  must resolve to and `crates.ts check-pins` compares it with the one nargo fetched.

## Cost

`member(label: Field, root: Field, path: LabelPath)` calling
`assert_lean_imt_member(hash_1([label]), path, root)` in a private function of a scratch contract,
`aztec compile` then `aztec profile gates`, Aztec 6.0.0:

| Function | Gates | Over the empty private function |
|---|---|---|
| `baseline()` (empty) | 4,992 | — |
| `member(...)` | 25,451 | 20,459 |

The verifier orders each pair before hashing once; hashing inside both branches of a runtime `if`
costs about 42,200 gates for the same membership.
