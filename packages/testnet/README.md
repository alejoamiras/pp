# @pp/testnet

The bridge on Sepolia and the public Aztec testnet: one committed deployment file per target, the key file,
and the guarded commands that deploy, open, run the canary and pause. Sepolia only: every command that signs
refuses any other L1 chain, mainnet by name, and any Aztec node but the pinned testnet one.

## Targets

`deployments/testnet-<target>.json` holds a target's `network` (pinned chain, rollup and endpoints), the
`expected` addresses and amounts, and the `pool` and `bridge` sections each run adds. `own` is a pool this
package deploys with pp-env's pinned build and approves through its own mock ASP; operator targets use an
existing pool and the operator's ASP. A run never edits the checkout: it writes a candidate section to
`~/.cache/pp/testnet/<target>/<run>/`, which is checked and committed before the next run.

## Keys

All keys live in `~/.config/pp/testnet.env`, outside every repository: directory 0700, file 0600,
`NAME=value` lines. `testnet.env.example` lists the names, with no values.

- `keys` creates the file and appends a key for every missing name, drawn from the OS's CSPRNG, and prints
  addresses only. It never rewrites a name.
- Each command parses the file itself and keeps only the names it needs. It refuses a file or directory
  another user owns or that group or others can read, and a link. Only `deploy-pool`'s Forge child gets a key
  in its environment.
- No value is ever formatted into output; every line a command prints is also scrubbed of the values it
  loaded. Every command refuses to run while `SEED` is set, which makes Aztec's randomness predictable.
- One address is funded by hand: the L1 deployer. `fund` tops each other L1 key up to its gas budget
  (`src/funding.ts`) at twice the fee estimate, never below 1 gwei; `fund --quote` reads no key and prints
  what the deployer must hold.

## Commands

`bun packages/testnet/src/cli/<command>.ts <deployment file> [public arguments]`. Argv carries addresses,
hashes and allowlisted URLs only. A guard refusal exits 2 before any key is read; a failure exits 1.

| Command | Keys | Does |
|---|---|---|
| `keys` | writes every missing name | creates the key file; prints addresses |
| `addresses` | every name | prints every key's address, for `expected`; no network |
| `fund [--quote]` | L1 deployer | tops the other L1 keys up to their budgets |
| `verify-inputs` | none | frozen lockfile, the pinned Forge binary with FFI off, a forced bridge build and the pool build against their pins, L2 class ids, and both endpoints' reads by block hash |
| `deploy-pool` (own) | pool deployer | the pinned pool, the test token minted to the canary owner, the postman role for the ASP key, every contract's runtime code checked against the build |
| `asp --owner <address>` (own) | ASP postman | the mock ASP on its loopback port: approves only that owner's deposits, posts roots, serves reads only |
| `seed [--recipient <address>]` | canary owner | registers and makes the canary deposit; with `--recipient`, deposits it for that registered address instead |
| `deploy` | L1 deployer, L2 deployer | the bridge generation with entries paused |
| `verify-deployment [--pool-only] [--bot] [--label <l> --min-sequence <s>]` | none | code, bindings, the factory's creation, class ids, paused entries, the checks before opening, the bot's record |
| `bot` | bot poster, bot intake | the ASP-root poster, snapshot server and birth intake, on the file's loopback port |
| `open --factory <address>` | guardian | opens entries once every check before opening passes and the guardian holds gas for three pauses |
| `pause --factory <address> [--nonce <n> [--replace]]` | guardian | pauses entries; done only when finalized |
| `canary --min-sequence <s> --post <txHash>` | canary owner, canary sender | the end-to-end canary; exit 3 when the epoch proof is not seen in time |
| `canary --settle <l2TxHash>…` | canary sender | settles burns an earlier canary left |

Run order for the own target: `keys`, `addresses` (commit `expected`), `fund`, `verify-inputs`,
`deploy-pool`, `verify-deployment --pool-only`, `asp`, `seed`, `deploy`, `verify-deployment`, `bot`,
`open`, `canary`, `pause`.

`--rehearse <stack manifest>` runs a command against the local stack with sandbox keys from
`PP_REHEARSE_<name>` (L1 keys must be anvil's) and never opens a key file. `--rehearse-fork <url>` runs it
against a loopback anvil fork of Sepolia with the key file of a scratch `$HOME`, refusing this account's
own home.

## Tests

| Script | What |
|---|---|
| `test` | unit tests, including every key-reading command spawned against a fake loopback L1 with sentinel keys |
| `pins`, `pins:check` | rewrite or compare the pool creation codes and class ids (needs pp-env's fetch and the L2 artifacts) |
