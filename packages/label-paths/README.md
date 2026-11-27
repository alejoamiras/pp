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

## One tree at most

Steps 3 to 5 build both trees, then the origin's tree twice more. A client that pays for hashing,
such as a browser, should use these instead:

1. `parseAspSnapshotUnverified(json)` runs every check of `parseAspSnapshot` except the two roots, so
   it builds no tree.
2. `cache.check(record, snapshot, label, origin, anchorTime)` on one long-lived
   `new LabelPathCache({ onProgress })`:
   - The snapshot's roots are compared with the record's before anything is hashed. A mismatch is
     `{ state: "STALE_ROOT", reason: "snapshot" }`: fetch the record's own sequence. A record too old
     for a spend is `reason: "age"`: wait for the next post.
   - A label not in its origin's list is `ABSENT` after one leaf hash, with no tree built.
   - A found label builds only its origin's tree, once. The answer is `ACTIVE` with the path from that
     tree, or `SnapshotError("RootMismatch")` if the list does not build to the declared root.
   - Verified trees are kept by root, so a later record with the same root (a heartbeat) costs no
     rebuild. A tree is dropped once the record's roots move on.
3. `onProgress(hashed, total)` reports each build's hashes against its exact total; a Web Worker can
   forward it.

The answers and their trust limits are those of `labelState` and `pathFor`.

## Wire format

A snapshot is a JSON object with exactly `sequence`, `poolRoot`, `birthRoot`, `poolLeaves` and
`birthLeaves`, every number a decimal string. Leaves are tree leaves, `hash_1(label)`, as the ASP
serves them: pool leaves in the ASP's order, birth leaves strictly ascending.

## Tests

`bun run --cwd packages/label-paths test`. `test/fixtures/mock-asp.json` comes from the pool's mock ASP:
`bun run --cwd packages/label-paths fixture <privacy-pools checkout>/packages/mock-asp`.
