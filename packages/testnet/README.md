# @pp/testnet

The bridge on Sepolia and the public Aztec testnet: one committed deployment file per target, the key file,
and the guarded commands that deploy, open, run the canary and pause. Sepolia only: every command that signs
refuses any other L1 chain, mainnet by name, and any Aztec node but the pinned testnet one. `keys` and
`addresses` read keys but sign nothing and do no network I/O, so neither checks what an endpoint serves.

## Targets

`deployments/testnet-<target>.json` holds a target's `network` (pinned chain, rollup and endpoints), the
`expected` addresses and amounts, and the `pool` and `bridge` sections each run adds. `own` is a pool this
package deploys with pp-env's pinned build and approves through its own mock ASP; operator targets use an
existing pool and the operator's ASP. A run never edits the checkout: it writes a candidate section to
`~/.cache/pp/testnet/<target>/<run>/`, which is checked and committed before the next run.

A pool's `deployBlock` is where note discovery starts, so it must not follow any of the pool's events, and
the file's L1 endpoint must serve logs from it. The own pool's comes from its deploy script, read before
broadcast. An operator target's is the earliest creation block of its vault, keystore and entrypoint, not
the operator API's `fromBlock`, which can be a later first deposit. `verify-deployment` checks both on the
file's own endpoint. The files pin the keyless Tenderly gateway, which keeps full history; the other pinned
endpoint keeps about 34 hours. `@pp/testnet/schema` exports the file's schema without Node or key-file
imports, for builds that read a deployment file.

Every L1 send goes to `network.l1SendRpc`, a second pinned endpoint, and every other call to `l1Rpc`:
the Tenderly gateway refuses sends under load. A live run refuses a file whose send endpoint is missing or
not pinned, and checks that it serves Sepolia before reading a key; a rehearsal's is loopback, or absent,
and then sends go where it reads. The send rules are `@pp/pp-env/send-path`'s, for the viem wallets and,
through a loopback relay, for `deploy-pool`'s Forge script, which gets fee caps of twice the fee estimate
(never below 1 gwei) and a 1 gwei tip. Each keyed run appends every send's hash, nonce and each answer to
`send-path.jsonl` in its run directory. `pause` sends through the same endpoint, so it needs it up.

## Keys

All keys live in `~/.config/pp/testnet.env`, outside every repository: directory 0700, file 0600,
`NAME=value` lines. `testnet.env.example` lists the names, with no values.

- `keys` creates the file and appends a key for every missing name, drawn from the OS's CSPRNG, and prints
  addresses only. It never rewrites a name.
- Each command parses the file itself and keeps only the names it needs. It refuses a file or directory
  another user owns or that group or others can read, a link, and a file with a second hard link. Only
  `deploy-pool`'s Forge child gets a key in its environment.
- No value is ever formatted into output; every line a command prints is also scrubbed of the values it
  loaded. Every command refuses to run while `SEED` is set, which makes Aztec's randomness predictable.
- One address is funded by hand: the L1 deployer. `fund` tops each other L1 address up to the summed
  gas budgets of the roles it holds (`src/funding.ts`) at twice the fee estimate, never below 1 gwei;
  `fund --quote` reads no key and prints what the deployer must hold, the top-ups' own gas included.
  Each top-up reports the seconds until the read endpoint showed it and until its receipt; one not shown
  within 60 s stops the run. The quote says whether the plan fits the owner's limits (`FUNDING_LIMITS`):
  at most 0.8 ETH spent and at least 1.0 ETH kept by the deployer. A live run refuses a plan that does
  not before it reads its key, and checks the deployer's live balance against them again before each
  send, counting what it already sent, so a top-up repeated after a wrong "not landed" verdict is
  refused. A fork run funds fresh keys from the fork's own ETH, so the limits only show in its quote.
  Every balance is read at one block, and the deployer's count there must equal its pending count on
  both endpoints, so a top-up that landed after that block, or is still pending, is never planned
  again; otherwise the run is refused, to be run again. Each top-up carries the gas limit and fee caps
  it was checked at, so it cannot cost more than the check allowed, and the nonce its place in the
  plan gives it from the snapshot count, so a transaction that lands after the snapshot makes it fail
  at the send rather than pay twice.
- The budgets are Prague gas, which the rehearsals check, times live Sepolia's measured cost over Prague
  for the role's kind of transaction: 7.67 for creations, 5.01 for fresh storage. Sepolia's fork since
  2026-10-06 reprices state creation, which a rehearsal on anvil 1.7.1 cannot show; a role still short
  fails at the node's gas estimate, before it sends.
- `DEMO_OWNER_KEY` and `DEMO_SENDER_KEY` are the owner's two hand-test accounts, `expected.demoOwner` and
  `expected.demoSender`: the demo owner holds notes, the demo sender sends the bridge transactions. The
  owner reads both values from the key file in their own terminal and imports them into their
  wallet; no command prints, logs or hands over either. A key file made before them gains both from
  `keys`, which `addresses` needs first. Once `expected` names them, `fund` tops each up to 5 M gas,
  `seed --demo` registers the demo owner and deposits for it, and `asp` approves the demo owner's own
  deposits when given its address.

## Commands

`bun packages/testnet/src/cli/<command>.ts <deployment file> [public arguments]`. Argv carries addresses,
hashes and allowlisted URLs only. A guard refusal exits 2 before any key is read; a failure exits 1.

| Command | Keys | Does |
|---|---|---|
| `keys` | writes every missing name | creates the key file; prints addresses |
| `addresses` | every name | prints every key's address, for `expected`; no network |
| `fund [--quote]` | L1 deployer | tops the other L1 addresses up to their roles' budgets |
| `verify-inputs` | none | a clean working tree (naming HEAD), frozen lockfile, the pinned Forge binary with FFI off, a forced bridge build and the pool build against their pins, L2 class ids, and both endpoints' reads by block hash |
| `deploy-pool` (own) | pool deployer | the pinned pool, built with no key and checked against `pool-creation-codes.json` before its key reaches Forge; the test token minted to the canary owner, the postman role for the ASP key, every contract's runtime code checked against the build |
| `asp --owner <address>…` (own) | ASP postman | the mock ASP on its loopback port: approves only the deposits of the owners given, each the canary owner or the demo owner, posts roots, serves reads only |
| `seed [--recipient <address> \| --demo]` | canary owner; demo owner with `--demo` | registers and makes the canary deposit; with `--recipient`, deposits it for that registered address instead; with `--demo`, registers the demo owner's keystore from its own key and gas, then deposits for it |
| `deploy` | L1 deployer, L2 deployer | the bridge generation with entries paused |
| `verify-deployment [--pool-only] [--bot] [--label <l> --min-sequence <s>]` | none | code, bindings, the deploy block's history, the factory's creation, class ids, paused entries, the checks before opening, the bot's record |
| `bot` | bot poster, bot intake | the ASP-root poster, snapshot server and birth intake, on the file's loopback port |
| `open --factory <address>` | guardian | opens entries once every check before opening passes and the guardian holds gas for three pauses |
| `pause --factory <address> [--nonce <n> [--replace --pending <hash>]]` | guardian | pauses entries; done only when finalized |
| `canary --min-sequence <s> --post <txHash>` | canary owner, canary sender | the end-to-end canary; exit 3 when the epoch proof is not seen in time |
| `canary --settle <l2TxHash>…` | canary sender | settles burns an earlier canary left |

`pause` prints a `pause-failed` line with a code and the nonce to act on. After PAUSE_BLOCKED, run
`pause --nonce <n>`. After PAUSE_STALLED, run `pause --nonce <n> --replace --pending <hash>`, passing
the hash on that line. After PAUSE_NONCE_OCCUPIED, wait for the pending transaction, or replace it the
same way with its hash (an open's is in `open`'s log). A replacement reads that transaction from every
pinned endpoint, refuses one that is not the guardian's at that nonce, and outbids each of its fee fields
by a quarter, paying at least four times the estimate.

Run order for the own target: `keys`, `addresses` (commit `expected`, the demo accounts included), `fund`,
`verify-inputs`, `deploy-pool`, `verify-deployment --pool-only`, `asp` with an `--owner` for the canary
owner and one for the demo owner, `seed`, `seed --demo`, `deploy`, `verify-deployment`, `bot`, `open`,
`canary`, `pause`. Then the owner imports the two demo keys into their wallet, from the key file, and
hand-tests.

The key file is the only place a key rests on disk. `deploy`'s L2 deployer, `bot` and `canary`'s fresh
account keep their wallet stores in RAM, as `/dev/shm/pp-<label>-…` directories (0700), and remove them on
exit or on a signal. `deploy`'s run directory keeps only its journal (0600): addresses, the hub's salt and
hashes. A run killed outright (SIGKILL, out of memory, a crash) leaves its store in RAM until the next store
of that label is made, which removes those whose owner is gone, or the host reboots. After such a run,
`ls -ld /dev/shm/pp-*` and remove each store whose name carries a pid no longer running.

`--rehearse <stack manifest>` runs a command against the local stack, at exactly that manifest's L1 and
node URLs, with sandbox keys from `PP_REHEARSE_<name>` (L1 keys must be anvil's) and never opens a key file.
`--rehearse-fork <url>` runs an L1 command against a loopback anvil fork of Sepolia, once the URL answers as
the pinned anvil, with the key file of a scratch `$HOME`, refusing this account's own home. A fork has no
Aztec node of its own, so commands that use L2 rehearse on the local stack only.

## Tests

| Script | What |
|---|---|
| `test` | unit tests, including the key-reading commands spawned with sentinel keys, those that reach L1 against a fake loopback one |
| `pins`, `pins:check` | rewrite or compare the pool creation codes and class ids (needs pp-env's fetch and the L2 artifacts) |
| `rehearse send-faults` | `fund` and `deploy-pool` on an anvil fork of Sepolia, reading and sending through fronts that inject faults: 429s in a row, a lost answer whose re-send meets "already known", a stale nonce and null receipt after a write, a reverted estimate, one read error, and a stale count at forge's last nonce, past which the wallet's sends must go on at the next nonces; each must fire, and every transaction lands once (one hash per nonce in the send log) before `verify-deployment --pool-only`. First, each from its own snapshot after `fund`, two negative cases: a send refused past the budget must stop `deploy-pool` naming its hash, nonce and the transactions landed, its refusals spanning at least 33 s; and `deploy-pool` killed outright mid-deploy must leave forge to end by itself (about 10 s) with nothing more landed. About 100 s (needs pp-env's fetch) |
| `rehearse pause` | the guardian's failure and recovery cases (a pending open with a lost send, a nonce gap, an occupied nonce and both manual branches, a finality time-out, a stalled pause) and `deploy`'s stale-build refusal, through the real CLIs with real sends, each on a bare local anvil; about 33 min, since the CLI's own 10- and 30-minute budgets run in full (needs `contracts/bridge/evm/out` at the committed build) |
