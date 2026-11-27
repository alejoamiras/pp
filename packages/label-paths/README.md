# @pp/label-paths

Browser-safe helpers for checking a label against the ASP registry on Aztec. The package imports only
`@pp/bridge-spec`'s root entry: no Aztec package, no viem, no `node:` module.

## What a client does

1. Read the record at the block the proof will anchor to:
   `readRootRecord({ aztecNode, registry, at: anchorBlock })`. `registry` is the address's
   `AztecAddress.toString()` (`0x` and 64 lower-case hex digits).
2. Fetch `GET <bot>/v1/snapshots/<record.sequence>`. A 404 means the server does not hold that
   sequence: read the latest record and retry.
3. `parseAspSnapshot(await res.json())` recomputes both roots, so a path verifies against the
   snapshot's own roots, whoever served it; step 4 checks those roots against the record. A matching
   root does not prove the leaves are complete: a subtree
   collapsed into one node keeps the root. `ABSENT` means not found in the snapshot this server gave
   you; it is never proof that a label was revoked.
4. `labelState(record, snapshot, label, origin, anchorTime)` gives `ACTIVE`, `ABSENT` or `STALE_ROOT`,
   by the same rules as the registry's `check_label`. Pass the anchor time plus your proving budget:
   `ACTIVE` at the exact age limit fails a proof anchored one block later.
5. `pathFor(snapshot, label, origin)` gives the membership path to pass to the contract.

`origin` is the note's origin: `0` for a note minted from the bridge (the pool tree), `1` for a shield
(the birth tree).

## Wire format

A snapshot is a JSON object with exactly `sequence`, `poolRoot`, `birthRoot`, `poolLeaves` and
`birthLeaves`, every number a decimal string. Leaves are tree leaves, `hash_1(label)`, as the ASP
serves them: pool leaves in the ASP's order, birth leaves strictly ascending.

## Tests

`bun run --cwd packages/label-paths test`. `test/fixtures/mock-asp.json` comes from the pool's mock ASP:
`bun run --cwd packages/label-paths fixture <privacy-pools checkout>/packages/mock-asp`.
