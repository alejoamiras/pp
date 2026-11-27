# Bridge L2 contracts (Noir)

L2 contracts for the any-ERC-20 bridge: `token_bridge_hub` — one hub per generation, bound
at construction to `[token_class_id, l1_factory, registry]`. It consumes the factory's `register`
message (sender-keyed to the factory, the portal inside the content), derives and publishes the
token's L2 `LabelledToken` (`deployer = hub`, `salt = erc20`, minter = hub, the hub's ASP registry
in its constructor) and mints into it from a pool withdrawal's bridge message (`claim_from_pool`:
the claiming account is the recipient, and the note keeps the pool's label). `ragequit` burns a
label's notes and sends the portal the message that pays an Ethereum address, with a public
`RagequitTicket` that names no Aztec account; every refusal comes before the burn. A transaction's
fee payer is public, so a ragequit paid from the holder's own Fee Juice names the holder: pay it
through a fee-paying contract. `exit_public` burns the caller's public balance, which the token's
checked `unshield` fills, and sends the portal the label-0 exit message with a public
`PublicExitTicket`; its refusals also come before the burn, and the burn names the caller.
`exit_private` sends the same message and ticket from the caller's notes in one private call: the
token's `burn_checked_for_exit` applies `unshield`'s registry check, and its public steps run as the
token and the hub, so a transaction paid through a fee-paying contract names no Aztec account.
`bind_token` is the publish-free twin the TXE drives; on a real network no factory leaf can be
spent through it (pinned). `claim_secret` and `register_hash` are the shared derivation libraries; `keystone` pins
them against their TypeScript and Solidity mirrors. `bridge_message` (the v1 bridge contents)
and `pp_hash` (circom Poseidon, label paths, birth hashes) implement the wire format that
[`packages/bridge-spec`](../../../packages/bridge-spec/README.md) specifies; keystone runs its
generated `src/vectors_v1.nr` against them.

`labelled_token` is the token every note of which carries a deposit label and an origin; its
surface, budgets and network suite are described in [`@pp/labelled-token`](../../../packages/labelled-token/README.md).
`bridge_stub` is its test-only minter: the TXE suite and the network suite deploy it in the hub's
place. The TXE runner rebuilds a crate, and the artifacts it stages, before running its suite. An
artifact a suite reads in place by path is not rebuilt (the hub's tests read `labelled_token` and
`asp_registry` this way), so compile that crate after editing it.

## Toolchain — the pinned 6.0.0 nargo

The crates pin aztec-nr and `compressed_string` (`aztec-labs-eng/aztec-nr`) at the `v6.0.0` tag: the `@aztec-labs/*` version, which the
local network runs (the `@aztec-foundation/*` packages carry their own number). Every
manifest names aztec-nr by the identical URL, with no trailing slash: a different spelling makes
Nargo build a second `aztec` crate. A mismatched toolchain fails with a flood of macro errors
(`cannot find self`, `Could not resolve 'at'`). Always compile via `scripts/compile.sh`, which
selects it:

```bash
scripts/compile.sh            # AZTEC_HOME defaults to ~/.aztec/versions/<the crates' aztec-nr tag>
scripts/compile.sh --check    # CI: a rebuild must reproduce the committed class id (program hash) and ABI
```

The committed `token_bridge_hub/target/*.json` is a build input for `@pp/bridge-core`
(`src/artifacts.ts`) and the local-network harness; a class-id shift there is a new generation,
never a re-pin of a deployed hub.

## Tests

- **TXE**: `scripts/run-txe-tests.sh` rebuilds the crate (the suite deploys the contract from its
  `target/` artifact), then runs the 52 named tests in `token_bridge_hub/txe-manifest.txt` against a
  TXE server whose dependencies are the committed mini-project `txe-server/` (frozen
  lockfile — never an ad-hoc `bun add`). `token_bridge_hub/txe-ts-map.md` maps every cross-boundary
  property to its L1 / TS counterpart. The TXE cannot run the protocol registry publish
  (`publish_contract_instance_for_public_execution`) and a TXE block carries no L2→L1 message, so
  the hub network suite (`bun run --cwd packages/bridge-core test:hub`) is the gate for both.
- **Sole-consumer invariant** (two consume sites, `_bind` and `claim_from_pool`, none in a path
  dependency; no nullifier push in the hub or a path dependency but two pinned labelled-token
  statements that run as the token; the claim's recipient, portal, commitment, secret and content are pinned) enforced
  statically by `scripts/check-sole-consumer.sh`.
- **Keystone**: the register hash (Solidity ↔ Noir ↔ TS) is pinned in
  `contracts/bridge/evm/test/Keystone.t.sol`, the `keystone` crate and
  `packages/bridge-core/src/register-hash.test.ts`; the claim secret (Noir ↔ TS) in the `keystone`
  crate and `packages/bridge-spec/src/claim-secret.test.ts`. The v1 bridge, exit and ragequit
  contents are bound by `packages/bridge-spec`'s vectors.

## ASP root registry — `asp_registry`

`AspRootRegistry` holds the latest ASP roots on Aztec in one record: `pool_root` (Ethereum's ASP root
at `l1_block`, comparable there by anyone), `birth_root` (labels born on Aztec), and `root_time`, the
timestamp of the Ethereum block the poster read. A token checks a label with one private call,
`label_check::check_label`: it reads the record at the transaction's anchor, applies the freshness
rule and the expiry, and proves `hash_1([label])` is in the tree of the notes' origin with
`pp_hash`'s LeanIMT path. An unshield then re-checks the roots in public with `assert_current`.

Beside the record, `post_root` stores the length of each list (`ListSizes`, read with `get_sizes`),
in a fixed slot outside the declared storage: the token, hub and probe artifacts embed the registry's
storage layout, which their class ids hash. A LeanIMT root does not fix its list's length, so a client
needs the length to refuse a list collapsed into inner nodes; no contract reads it.

Posting rules: exactly the next `sequence`; `pool_root != 0`; `l1_block` and `root_time` never go
back; a repeated `l1_block` keeps its `root_time`; `root_time <= now`; `now - root_time <= 1800 s`;
`pool_size != 0`; `birth_size` is 0 exactly when `birth_root` is; neither length exceeds 2^18.
The repeated-block rule catches a bot bug, not a dishonest poster, which can raise the block instead.
It also means block 0 can never be posted, first or after a reset, and that after an Ethereum reorg
the replacement block must still carry a time no earlier than the last post's.

What each key can do:

- **Poster.** Post records within those rules. It can approve any Aztec-born label (`birth_root`),
  post a `pool_root` that differs from Ethereum's (visible to anyone who compares), post a length
  other than its list's (a collapsed list then passes the client's check), pair an old root with a
  fresh time, or stop posting. It cannot change the poster, the admin or the birth intake,
  and nothing here can mint, burn, move notes or block a claim or a ragequit.
- **Admin.** Replace the poster and set the birth intake (zero pauses shields). Replacing the poster
  clears the roots, the lengths, the block and the time for later anchors, at the sequence after the
  record it replaces, so a post prepared against that record can no longer land. Two resets in flight
  land in either order; each advances the sequence, and the one that executes last sets the poster.
  A new or zero intake
  applies to shields anchored after it: a shield anchored earlier still announces to the old intake
  until its transaction expires. It cannot post unless it makes itself poster, and nobody can change
  the admin.

Events: `post_root` emits `RootPosted` (the record's five fields, then both lengths), `set_poster` emits
`PosterChanged` (the cleared record's sequence and the new poster) and `set_birth_intake` emits
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

Tests: `scripts/run-txe-tests.sh --crate asp_registry` and `--crate asp_registry_probe` run the names
in each crate's `txe-manifest.txt`. `asp_registry_probe` is a test-only contract that calls the
library the way a token does.
