# Bridge L2 contracts (Noir)

L2 contracts for the any-ERC-20 bridge: `token_bridge_hub` — one hub per generation, bound
at construction to `[token_class_id, l1_factory, guardian]`. It consumes the factory's `register`
message (sender-keyed to the factory, the portal inside the content), derives and publishes the
token's L2 `Token` (aztec-standards, `deployer = hub`, `salt = erc20`, minter = hub), claims into
it (`claim_public` / `claim_private` — the latter recipient-committed) and exits back to Ethereum
(`exit_to_l1_public` / `exit_to_l1_private`, burn before the withdraw message). The guardian can
pause exits only. `bind_token` / `bind_and_claim_public` are the publish-free twins the TXE drives;
on a real network no factory leaf can be spent through them (pinned). `claim_secret` and `register_hash` are the shared derivation libraries; `keystone`
pins them against their TypeScript and Solidity mirrors. `bridge_message` (the v1 bridge contents)
and `pp_hash` (circom Poseidon, label paths, birth hashes) implement the wire format that
[`packages/bridge-spec`](../../../packages/bridge-spec/README.md) specifies; keystone runs its
generated `src/vectors_v1.nr` against them.

## Toolchain — the pinned 6.0.0 nargo

The crates pin aztec-nr and `compressed_string` (`aztec-labs-eng/aztec-nr`) and the standards `token`
(`AztecProtocol/aztec-standards`) at the `v6.0.0` tags: the `@aztec-labs/*` version, which the
local network runs (the `@aztec-foundation/*` packages carry their own number). Every
manifest names aztec-nr by the identical URL, with no trailing slash: a different spelling makes
Nargo build a second `aztec` crate. The content-hash library is vendored at
`token_portal_content_hash_lib/` (its header names the upstream commit and digest) and consumed by
path. A mismatched toolchain fails with a flood of macro errors
(`cannot find self`, `Could not resolve 'at'`). Always compile via `scripts/compile.sh`, which
selects it:

```bash
scripts/compile.sh            # AZTEC_HOME defaults to ~/.aztec/versions/6.0.0 (aztec-up install 6.0.0 first)
scripts/compile.sh --check    # CI: the class id derived from a rebuild must equal the committed one
```

The committed `token_bridge_hub/target/*.json` is a build input for `@pp/bridge-core`
(`src/artifacts.ts`) and the local-network harness; a class-id shift there is a new generation,
never a re-pin of a deployed hub.

## Tests

- **TXE**: `scripts/run-txe-tests.sh` runs the 65 named tests in `token_bridge_hub/txe-manifest.txt`
  against a TXE server whose dependencies are the committed mini-project `txe-server/` (frozen
  lockfile — never an ad-hoc `bun add`). `token_bridge_hub/txe-ts-map.md` maps every cross-boundary
  property to its L1 / TS counterpart. The TXE cannot run the protocol registry publish
  (`publish_contract_instance_for_public_execution`) — the sandbox smoke is that gate.
- **Sole-consumer invariant** (three named consume sites; `claim_private` derives its secret)
  enforced statically by `scripts/check-sole-consumer.sh`.
- **Keystone** content-hash / register-hash / claim-secret equality (Solidity ↔ Noir ↔ TS) pinned in
  `contracts/bridge/evm/test/Keystone.t.sol` + `packages/bridge-core/src/{content-hash,register-hash,claim-secret}.test.ts`.

## ASP root registry — `asp_registry`

`AspRootRegistry` holds the latest ASP roots on Aztec in one record: `pool_root` (Ethereum's ASP root
at `l1_block`, comparable there by anyone), `birth_root` (labels born on Aztec), and `root_time`, the
timestamp of the Ethereum block the poster read. `label_check` is how a token reads the record from a
private function.

Posting rules: exactly the next `sequence`; `pool_root != 0`; `l1_block` and `root_time` never go
back; a repeated `l1_block` keeps its `root_time`; `root_time <= now`; `now - root_time <= 1800 s`.
The repeated-block rule catches a bot bug, not a dishonest poster, which can raise the block instead.
It also means block 0 can never be posted, first or after a reset, and that after an Ethereum reorg
the replacement block must still carry a time no earlier than the last post's.

What each key can do:

- **Poster.** Post records within those rules. It can approve any Aztec-born label (`birth_root`),
  post a `pool_root` that differs from Ethereum's (visible to anyone who compares), pair an old root
  with a fresh time, or stop posting. It cannot change the poster, the admin or the birth intake,
  and nothing here can mint, burn, move notes or block a claim or a ragequit.
- **Admin.** Replace the poster (which clears the roots, the block and the time for later anchors,
  and keeps the sequence) and set the birth intake (zero pauses shields). A new or zero intake
  applies to shields anchored after it: a shield anchored earlier still announces to the old intake
  until its transaction expires. It cannot post unless it makes itself poster, and nobody can change
  the admin.

Events: `post_root` emits `RootPosted` (the record's five fields), `set_poster` emits
`PosterChanged` (the kept sequence and the new poster) and `set_birth_intake` emits
`BirthIntakeChanged`. They keep the order of several updates in one block for a watcher; storage
stays the authority, and nothing on chain reads them.

Freshness: a checked spend's anchor may be at most 30 minutes past `root_time` (inclusive), and the
spend expires by 30 minutes after its anchor, so it lands at most 60 minutes past `root_time`. If posts
stop, checked spends anchored more than 30 minutes after the last `root_time` fail; claims and
ragequits never read the registry. A record observed from an Ethereum block `L` s old and included `I` s later is
usable for new anchors for `1800 - L - I` s: about 11-17 minutes on Sepolia's finalized tag
(`L` = 768-1152 s), which bounds how often the poster must land a post.

Known limits: `birth_root` has no Ethereum counterpart, so no watcher can compare it: the registry
takes the poster's value. Only `pool_root` can be compared, with `root_time`, against Ethereum at
`l1_block`. An unshield reverts if the current pair, when it executes, differs from the pair it was
proved against, whichever tree it used. So an honest post can revert in-flight unshields too, and a
new birth approval reverts pool-origin ones; a pair that was replaced and then restored, even across
a poster rotation, passes again. A lost or stolen admin key cannot be replaced
on chain; recovery is a new registry and a new token generation. While one tree's root is zero, a
successful checked spend shows which tree it used.

Tests: `scripts/run-txe-tests.sh --crate asp_registry` runs the names in `asp_registry/txe-manifest.txt`.
