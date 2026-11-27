# @pp/labelled-token

The labelled token's artifact and its tooling. The contract lives in
[`contracts/bridge/aztec/labelled_token`](../../contracts/bridge/aztec/labelled_token): an Aztec 6.0.0
token whose every private note carries a deposit **label** and an **origin** (`0` pool, `1` birth).
Stage A is the hold-and-leave surface; stage B adds spends checked against the ASP root registry
([`asp_registry`](../../contracts/bridge/aztec/asp_registry)) and a public balance; stage C adds
shields, which create labels born on Aztec.

| Function | Caller | Effect |
|---|---|---|
| `constructor(name, symbol, decimals, minter, registry)` | deployer | Fixes the metadata and `Config { minter, registry }`; refuses a zero minter. A stage-A generation passes `registry = 0`; every checked spend then fails with "registry unset". |
| `mint_from_bridge(to, amount, label)` | minter only | Writes one note of `amount` under `label`, origin pool, to `to`. Refuses a zero amount, a zero label and an off-curve `to`. |
| `burn_for_exit(from, amount, label)` | minter only | Spends at most 8 of `from`'s notes of `label`, largest first, and returns any change under the same label and origin. Fails with "Balance too low" when 8 notes do not cover `amount`; fails with "mixed origin" when they disagree. |
| `balance_of_private(owner)` | utility | The owner's total over every label. |
| `private_balances_by_label(owner, start)` | utility | `(label, origin, balance)` per label, 16 per page, from the `start`-th. Tracks at most 256 labels per owner. |
| `private_notes_by_label(owner, label, start)` | utility | One label's note values, largest first, 10 per page: the exact chunks a caller can burn. |
| `transfer_private(to, amount, label, path)` | any holder | Spends the caller's `label` notes as `burn_for_exit` does, then proves `label` is in the registry's tree of those notes' origin at the anchor (`check_label`), which also sets the expiry to anchor + 1800 s. Writes `(label, origin, amount)` to `to` and the change to the caller. Refuses a zero or off-curve `to` and a zero amount. |
| `unshield(amount, label, path)` | any holder | As `transfer_private`, crediting the caller's public balance instead. Refused in the setup phase. The public step `finish_unshield` (callable only by the token) reverts unless both registry roots are still the ones the spend was checked against; after such a revert the notes stay spendable, and until that tx is final any spend that returns change to the caller fails (the change's delivery must follow the dropped one), so it can leave only in exact chunks. |
| `shield(amount)` | any holder | Moves `amount` of the caller's public balance into one note of origin birth under a new label, `label′ = birth_label(token, owner, amount, secret)` (`pp_hash::birth`; the prover draws the secret). Pushes the birth nullifier and announces `BirthAnnouncement { label, secret, owner, amount }` to the registry's birth intake, read at the anchor. The public step `debit_for_shield` (callable only by the token) debits the caller and emits `ShieldDebited { birth_id, owner, amount }`. Refused in the setup phase, for a zero amount, and while the intake is zero (shields paused) or off-curve. Sets the expiry to anchor + 1800 s. The note spends once the birth tree admits `label′`; it can be burnt for exit at any time. |
| `transfer_public(to, amount)` | any holder | Moves public balance. Refuses a zero or off-curve `to`, the private-side sentinel address and a zero amount. |
| `burn_public_for_exit(from, amount)` | minter only | Burns `from`'s public balance. |
| `balance_of_public(owner)` | public view | The owner's public balance. |

Every balance note and every birth announcement is delivered constrained under a non-interactive
handshake (`balance_set.nr`, `delivery()`), so a recipient finds it from the chain with no registered
sender, unless the pair already shares an interactive handshake (see below).

## Entries

- `.` ([`src/index.ts`](src/index.ts)): the artifact and its type. Browser-safe; nothing Node-only is
  reachable from it.
- `scripts/gates.ts`: `bun run gates` profiles every private function into `bench/gates.json`;
  `gates:check` fails on drift or on a function over `bench/budget.json`; `gates -- --stock` profiles
  the stock aztec-standards Token into `bench/stock-gates.json`.
- `scripts/handoff.ts`: `bun run handoff` writes `bench/handoff.json`, the class id and the address a
  hub derives for this token (`deployer = hub`, `salt = erc20`, the factory words as `str<31>`), for
  a zero and a non-zero registry. `test/handoff.test.ts` fails when it is stale.
- `scripts/fixtures.ts`: `bun run fixtures` renders the TXE suite's LeanIMT trees (path depths 0, 1,
  3 and 18, a promoted leaf, a pool label inside the birth tree) from `@pp/bridge-spec` into the
  crate's `src/test/paths.nr`; `fixtures:check` fails when that file is stale.
- `scripts/prove.ts`: `bun run bench:prove` boots its own local network and measures, on one proving
  wallet, the whole-tx gates and the client proving time of a 1-note `transfer_private` against the
  stock token's `transfer_private_to_private`, to a recipient the sender has paid before and to a
  fresh one, plus an 8-note spend; the two tokens' proofs alternate, so changing host load hits both
  alike. It writes `bench/proving.json` and fails unless the reused-recipient
  row stays within stock + 60,000 gates and 1.5 × stock's median proving time.

## Tests

| Layer | Command | What it proves |
|---|---|---|
| Unit | `bun run test` | The ABI surface (no parameter named `offset`, which aztec-nr's call stubs shadow), the gate budgets, the handoff vector. |
| TXE | `bash contracts/bridge/aztec/scripts/run-txe-tests.sh --crate labelled_token` | The contract's rules, against an artifact the runner rebuilds from source (and those of the test minter and the registry). |
| Network | `bun run test:net` | Stage A and B across separate devices on a local network: discovery, recovery, spends proven against one registry record and landing under another, expiry, and the setup-phase refusal. |
| Proving | `bun run bench:prove` | The cost budget against the stock token, with a real prover. |

`test:net` boots one anvil and one local network for the run under the run id `tok-<pid>-<time>` and
removes every port row and directory it made.

## Leaving from a restored device

A holder can always leave from a device restored from the account's keys alone, with one exception:
balance notes tagged under an interactive handshake that the holder's wallet signed for that note's
(sender, holder) pair stay hidden until the wallet imports that handshake's ephemeral key
(`eph_pk.x`). A wallet that signs interactive handshakes must back up each key. A wallet that cannot
sign one, such as the embedded test wallet, is not affected.

The exception exists because a handshake belongs to the (sender, recipient) pair across every app.
The token asks for a non-interactive handshake, which is announced on chain, but aztec-nr reuses any
handshake that already exists for the pair. A recipient's sync rediscovers only announced ones, so a
note tagged under a handshake another app opened interactively is invisible to a device that never
saw it signed. The import is a PXE call (`registerTaggingSecretSource({ kind: "handshake", recipient,
ephPk })`); the aztec.js `Wallet` interface has none.

[`test/net/recovery.test.ts`](test/net/recovery.test.ts) shows both halves on a local network. The
embedded wallet cannot open an interactive handshake at all. A test wallet that answers the
registry's signature request ([`test/net/handshake.ts`](test/net/handshake.ts)) reproduces the loss:
a keys-only restore sees no balance and cannot burn until it imports the key, and then it can.
