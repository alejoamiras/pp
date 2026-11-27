# @pp/bridge-spec

The v1 wire format of the bridge between the pool on Ethereum and Aztec, and the hashes both sides
recompute. This package is the reference implementation and the generator of the shared vectors;
Solidity (`contracts/bridge/evm/src/libraries/BridgeMessageV1.sol`) and Noir
(`contracts/bridge/aztec/bridge_message`, `contracts/bridge/aztec/pp_hash`) are checked against
those vectors, never against each other. **This README is normative.** A change to any rule below is
a new version (§ Adding v2), never an edit of v1.

## Entry points

| Import | What | Loads Barretenberg |
|---|---|---|
| `@pp/bridge-spec` | `TAGS`, `BN254_P`, `U128_MAX`, `MAX_DEPTH`, `sha256ToField`, `bridgeDataV1`, `bridgeContentV1`, `exitContentV1`, `ragequitContentV1`, `circomPoseidon1/2`, `changeCommitment`, `aspLeaf`, `buildLeanImt`, `leanImtRoot`, `assertLeanImtMember`, `deriveClaimKey`, `deriveClaimSalt`, `claimSecretHash`, `SpecRangeError` | no (`claimSecretHash` imports the mirror lazily) |
| `@pp/bridge-spec/claim-secret` | the claim-secret mirror of Noir `claim_secret_lib` (`deriveTokenClaimSecret`, `tokenClaimSecretHash`) | yes |
| `@pp/bridge-spec/birth` | `birthLabel`, `birthNullifier`, `siloedBirthNullifier`, `birthId` | yes |

`src/import-guard.test.ts` fails if anything reachable from the root entry imports `@aztec-labs/*`.

## Words and hashing

Every preimage is a sequence of 32-byte big-endian words (`abi.encode` of static types).
`H(x) = sha256ToField(x)`: the first 31 bytes of `sha256(x)` read as an integer
(`uint256(sha256(x)) >> 8`), so always below the BN254 scalar field modulus `p`.

Tags are ASCII strings read as big-endian integers, below 2^248 and so also fields. A right-padded
`bytes32("…")` would exceed `p` and match nothing on Aztec.

| Tag | ASCII | Word |
|---|---|---|
| `PP_BRIDGE_DATA_V1` | `pp.bridge.data.v1` | `0x00000000000000000000000000000070702e6272696467652e646174612e7631` |
| `PP_BRIDGE_IN_V1` | `pp.bridge.in.v1` | `0x000000000000000000000000000000000070702e6272696467652e696e2e7631` |
| `PP_BRIDGE_OUT_V1` | `pp.bridge.out.v1` | `0x0000000000000000000000000000000070702e6272696467652e6f75742e7631` |
| `PP_BRIDGE_RAGEQUIT_V1` | `pp.bridge.ragequit.v1` | `0x000000000000000000000070702e6272696467652e72616765717569742e7631` |

| Payload | Words | Bytes | Built by |
|---|---|---|---|
| `TransactParams.data` | `DATA_V1, secretHash` | 64 | Solidity, TS |
| Inbox content | `H(IN_V1, nullifier, changeCommitment, amount)` | 128 | Solidity, TS, Noir |
| Screened public-exit content | `H(OUT_V1, payee, amount)` | 96 | Solidity, TS, Noir |
| Ragequit content | `H(RAGEQUIT_V1, payee, amount, label)` | 128 | Solidity, TS, Noir |

The two exit contents differ in tag and length; each settle function rebuilds its own. Label 0 is
refused in the ragequit content, so an `ExitSettled` label of 0 always means the public exit.

## Widths and rejection names

Every encoder refuses a value outside its width wherever its type can hold the value, under one name
in all three languages: the Solidity custom error, the TS `SpecRangeError.code` and the Noir assert
message. Checks run in argument order.

| Rule | Name | TS | Solidity | Noir |
|---|---|---|---|---|
| `0 < secretHash < p` (TS: also exactly 32 bytes) | `SecretHashOutOfRange` | ✓ | ✓ | does not build data |
| `nullifier`, `changeCommitment` `< p` | `FieldOutOfRange` | ✓ | ✓ | `Field` holds no more |
| `1 ≤ amount ≤ 2^128 − 1` | `AmountOutOfRange` | ✓ | ✓ | `amount != 0`; `u128` holds the cap |
| `payee ≠ 0` | `ZeroPayee` | ✓ | ✓ | ✓ |
| payee word `< 2^160` (TS: exactly 20 bytes) | `PayeeOutOfRange` | ✓ | `address` holds no more | ✓ |
| `0 < label < p` | `LabelOutOfRange` | ✓ | ✓ | `label != 0` |
| `depth ≤ 18` | `DepthOutOfRange` | ✓ | — | ✓ |
| `index < 2^depth` | `IndexOutOfRange` | ✓ | — | ✓ |
| siblings past `depth` are 0 (TS: exactly 18 siblings) | `SiblingOutOfRange` | ✓ | — | ✓ |
| `root ≠ 0` | `ZeroRoot` | ✓ | — | ✓ |
| the path's root equals `root` | `NotMember` | ✓ | — | ✓ |

TS also refuses any hash or tree input `≥ p` (`FieldOutOfRange`; `poseidon-lite` would reduce it
silently), a tree leaf of 0 (`FieldOutOfRange`; zk-kit treats a zero right child as absent), a tree above
2^18 leaves (`TreeTooLarge`), a path into an empty tree (`EmptyTree`), and a
malformed signature, address or claim key (`InvalidSignature`, `InvalidAddress`, `InvalidKey`). For
a secret input (signature, claim key, claim salt, spent commitment, birth secret) the error carries
its code and field name only: no value, and no input bytes in its message or cause.

Noir's `EthAddress` defers its 160-bit check to the kernel tail, which never sees a payee inside a
content hash; `bridge_message` therefore asserts the payee width itself.

## Checks these libraries cannot make

| Check | Owner |
|---|---|
| `payee ≠ portal` | the portal's `settleRagequit` and `settlePublicExit`; the hub's `ragequit`, `exit_public` and `exit_private` |
| the claim's recipient | the portal builds `TransactParams`; the hub derives the claim secret from its caller |
| root freshness and the note's origin tree | the registry's `check_label`, the token |
| signer and payload of the claim-key signature | `@pp/pool-client` (§ Claim key and salt) |
| at most 2^18 leaves per tree | the bot, which builds the snapshots |

## Claim key and salt

- **Claim key**: `HKDF-SHA256(ikm = r, salt = the 20 raw address bytes, info = "pp.bridge/claim-key/v1", 32 bytes)`,
  where `r` is bytes 0–32 of the 64-byte (EIP-2098) or 65-byte (`v ∈ {0, 1, 27, 28}`, `r ≠ 0`)
  secret-derivation signature: the input the pool SDK derives its own keys from, with a different info.
- **Claim salt**: `OS2IP(HKDF-SHA256(ikm = claim key, salt = "pp.bridge/claim-salt/v1", info = be32(spentCommitment), 64 bytes)) mod p`.
  Deterministic, yet unpredictable without the key: the secret hash is public on Ethereum and the
  amount is public, so a guessable salt would let an observer test candidate recipients.
- **Secret hash**: `compute_secret_hash([derive_claim_secret(salt, recipient)])`; `claimSecretHash`
  computes it through the claim-secret mirror.
- **Authentication is the caller's.** The SDK derives keys from a signature it is given but does not
  ship the typed-data payload the wallet signs. That payload lives in the upstream sample app,
  `pp-env` pins a copy, and `@pp/pool-client` exports it as `secretDerivationTypedData(l1Address)`
  and verifies the signature against it. Authenticating the signer and the payload is pool-client's
  duty; a wrong one derives a key the user cannot reproduce. **A change to that payload, or to
  either derivation, is a new key version** (a new info label), never a regeneration.
- This package never logs or persists `r`, the key or the salt.

## Birth hashes

Aztec Poseidon2 with frozen `u32` separators, in TS (`@pp/bridge-spec/birth`) and Noir
(`pp_hash::birth`); Solidity never computes them.

| Value | Inputs | Separator |
|---|---|---|
| `label′` | `[token, owner, amount, birth_secret]` | `0x70626c31` (`pbl1`) |
| inner birth nullifier | `[owner, birth_secret]` | `0x70626e31` (`pbn1`) |
| birth id | `[label′, birth_secret]` | `0x70626931` (`pbi1`) |

The protocol silos the inner nullifier by the token's address; `siloedBirthNullifier` returns the
value that appears on chain.

## Label paths

`LabelPath { index, depth, siblings[18] }` is `@zk-kit/lean-imt`'s proof format: `depth` counts
siblings (a lone left child is promoted unhashed, so it is not the tree height), bit `i` of `index`
is 1 when the node is the right child at level `i`, and siblings past `depth` are 0. Nodes are
`circomPoseidon2(left, right)` and leaves are `aspLeaf(label) = circomPoseidon1(label)`; an empty
tree's root is 0 and admits nothing. Noir loops over all 18 levels, orders each pair by its index
bit, hashes once and keeps the parent only below `depth`; its cost is in `pp_hash/README.md`.

Known limits:

- **A path proves membership, not position.** Equal siblings leave that level's direction bit free.
  Nothing derives a position or a nullifier from a path, and callers hash `hash_1([label])`
  themselves. Revisit if a caller needs an authenticated position or accepts a prover-chosen leaf.
- **Trees above 2^18 leaves are refused**, since an old leaf could then need depth 19. Revisit before
  either tree nears the cap; raising it changes circuit cost and the witness.

## Vectors

`vectors/gen.ts` builds one deterministic corpus and renders it twice: `vectors/v1.json` and the
keystone's `contracts/bridge/aztec/keystone/src/vectors_v1.nr`. Seeded cases come from
`sha256("pp.bridge.vectors.v1" ‖ section ‖ be32(i))`; signatures use viem's RFC 6979 signing.
`vectors/spike.ts` holds independent anchors (circomlibjs and zk-kit outputs, including two paths
from a 131,073-leaf tree) copied into the corpus.

| Section | Vectors | Read by |
|---|---|---|
| `tags` | 4 | TS, Solidity, Noir (no data tag) |
| `data` | 66 | TS, Solidity |
| `in`, `out`, `ragequit` | 73, 69, 71 | TS, Solidity, Noir |
| `rejections` | 23, each tagged with the languages whose types hold its input | TS, Solidity, Noir |
| `hash1`, `hash2`, `commitment`, `aspLeaf` | 20, 19, 17, 17 | TS, Noir |
| `leanImt` | 31: every leaf of 1-, 2-, 3-, 4-, 5- and 7-leaf trees, two of 11, the anchor paths | TS, Noir |
| `claimKey`, `claimSalt` | 7 (one signature in three forms), 8 | TS |
| `claimSecretHash` | 8 | TS, Noir |
| `birth` | 12 | TS, Noir (the siloed nullifier through the protocol's silo helper) |

Plus `counts` and `noirTests` (the generated Noir test names). Each suite writes its required
sections, sizes and rejection names by hand, so a generator that drops a vector together with its
count still fails:

- TS: `src/vectors.test.ts` (one test per section; `BRIDGE_SPEC_VECTORS` points it at another copy).
- Solidity: `contracts/bridge/evm/test/BridgeMessageV1.t.sol`, through a read-only `fs_permissions`
  grant on `packages/bridge-spec/vectors`.
- Noir: `vectors:nargo` runs keystone once and requires every v1 test by name.

`vectors:mutate -- --suite ts|sol|nr` runs a suite against a control copy, which must pass, then
against a copy with one expected value flipped per section (one rejection name swapped), where every
section's test must fail naming that vector. The unit tests also hold frozen known answers computed
by independent code (RFC 5869, WebCrypto HKDF, viem `encodeAbiParameters`); those never regenerate.

| Command (`bun run --cwd packages/bridge-spec …`) | CI job |
|---|---|
| `vectors` | — (writes both files; commit both) |
| `vectors:check` | unit tests (both files equal a fresh generation, byte for byte) |
| `vectors:mutate -- --suite ts` | unit tests |
| `vectors:mutate -- --suite sol` | forge (needs Foundry 1.7.1 on `PATH`) |
| `vectors:nargo`, `vectors:mutate -- --suite nr` | nargo (needs `~/.aztec/versions/6.0.0`) |

Regenerating is for new vectors only. If a v1 output changes, an implementation changed, and that
is a bug or a v2.

## Adding v2

New tags (`pp.bridge.….v2`), new functions beside the v1 ones (`…V2` in TS and Solidity, `*_v2` in
Noir), a new `vectors/v2.json` with its own hand-written requirements in each suite, and new info
labels for any changed key derivation. v1's tags, functions and vectors stay as they are while any
deployed contract can still produce or consume a v1 message.
