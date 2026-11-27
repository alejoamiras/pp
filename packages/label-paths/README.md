# @pp/label-paths

Browser-safe helpers for checking a label against the ASP registry on Aztec. The package imports only
`@pp/bridge-spec`'s root entry: no Aztec package, no viem, no `node:` module.

## What a client does

1. Read the record at the block the proof will anchor to:
   `readRootRecord({ aztecNode, registry, at: anchorBlock })`. `registry` is the address's
   `AztecAddress.toString()` (`0x` and 64 lower-case hex digits). The record carries both roots and
   the length of each list, all read at one block.
2. Fetch `GET <bot>/v1/snapshots/<record.sequence>`. A 404 means the server does not hold that
   sequence: read the latest record and retry.
3. `parseAspSnapshotUnverified(await res.json())` checks every field and builds no tree.
4. `cache.check(record, snapshot, label, origin, anchorTime)` on one long-lived
   `new LabelPathCache({ onProgress })`, by the same rules as the registry's `check_label`:
   - The snapshot's roots are compared with the record's. A mismatch is
     `{ state: "STALE_ROOT", reason: "snapshot" }`: fetch the record's own sequence.
   - A record too old for a spend is `reason: "age"`: wait for the next post. Pass the anchor time
     plus your proving budget: `ACTIVE` at the exact age limit fails a proof anchored one block later.
     The time rule alone is `rootFresh(record, anchorTime)`, which needs no snapshot.
   - Each list's length is compared with the record's. A list of another length throws
     `SnapshotError("SizeMismatch")` before anything is hashed.
   - Then only the origin's tree is built. The answer is `ACTIVE` with the path to pass to the
     contract, `ABSENT`, or `SnapshotError("RootMismatch")` if the list does not build to the root,
     whether or not the label is in it.
   - Verified trees are kept by root. A later snapshot with the same root and the same list (a
     heartbeat) costs no rebuild. A tree is dropped once the record's roots move on.
5. `onProgress(hashed, total)` reports each build's hashes against its exact total; a Web Worker can
   forward it. It runs inside the build, so it must not call `check`.

`origin` is the note's origin: `0` for a note minted from the bridge (the pool tree), `1` for a shield
(the birth tree).

## What `ABSENT` means

`ABSENT` means the label is not in the list the record commits to, by root and length. A root alone
does not fix its list: a list collapsed into inner nodes builds to the same root and hides labels.
Its length differs, so it is refused. The same root and length mean the same list, unless the hash
(circom Poseidon over two inputs) has a collision, or an inner node is 0, which needs a preimage of 0.

The record commits the length the poster saw. A server that only hands out snapshots cannot hide a
label. The poster is still trusted: if the ASP feed it reads lied when it posted, the record holds that
list's length and the client cannot tell. The client also trusts the Aztec node it reads the record
from. In production the ASP itself posts.

## With a verified snapshot

`parseAspSnapshot(json)` builds both trees and checks both roots. On its result,
`labelState(record, snapshot, label, origin, anchorTime)` gives `ACTIVE`, `ABSENT` or `STALE_ROOT` by
the same rules, lengths included, and `pathFor(snapshot, label, origin)` gives the path; the two build
the origin's tree twice more. Their `ABSENT` holds only for a snapshot `parseAspSnapshot` returned.

## Wire format

A snapshot is a JSON object with exactly `sequence`, `poolRoot`, `birthRoot`, `poolLeaves` and
`birthLeaves`, every number a decimal string. Leaves are tree leaves, `hash_1(label)`, as the ASP
serves them: pool leaves in the ASP's order, birth leaves strictly ascending.

## Tests

`bun run --cwd packages/label-paths test`. `test/fixtures/mock-asp.json` comes from the pool's mock ASP:
`bun run --cwd packages/label-paths fixture <privacy-pools checkout>/packages/mock-asp`.
