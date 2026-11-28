# @pp/sepolia-fork

The bridge's Ethereum side against a real Privacy Pools deployment on Sepolia and the real Aztec testnet
Inbox, with no L2. Everything runs on an anvil fork this suite owns; no transaction reaches a live network.

## Use

```sh
SEPOLIA_RPC_URL=<public Sepolia endpoint with archive state> bun run --cwd packages/sepolia-fork run
```

`--target <name>` picks the deployment (`src/pins.ts`); each target pins its own block and names the
pool-client circuit bundle its verifiers embed.

| Target | Deployment | Bundle |
|---|---|---|
| `pool1` (default; the nightly's) | the operator's live pool, poolId 1 in its API | `ceremony` |
| `vault-323c` | an older deployment, vault `0x323C…8347`, that never had an ASP root | `pre-ceremony` |

The endpoint comes only from `SEPOLIA_RPC_URL`, with no default. Unset, `run` prints one skip line and
exits 0; `run --require-rpc` makes that a failure. The endpoint must serve state at the pinned block, so a
pruning node fails with "no longer serves block N". `bun run nightly sepolia-fork` runs it against the one
committed keyless gateway.

Prerequisites from a clean checkout: `bun install`, `bun run --cwd packages/pp-env fetch`,
`bash contracts/bridge/evm/scripts/install-libs.sh`, `bun packages/bridge-core/scripts/gen-remappings.ts`,
and `forge build` in `contracts/bridge/evm`, with Foundry 1.7.1 on `PATH` or in `~/.cache/pp/tools/`.

A run:

1. checks the endpoint serves Sepolia, the pinned block with its pinned hash, and state at that block;
2. fetches the target's circuits at pool-client's pins (once, into `~/.cache/pp/fork/artifacts/`) and
   hashes every file again;
3. forks the endpoint with Foundry 1.7.1's anvil at the pinned block, on a claimed loopback port, as its own
   process group, which ends and frees its row even when the runner is SIGKILLed (Forge's groups too; the
   mock ASP's row and the run's data and fixture directories stay then, for removal by hand); the run fails
   as soon as that anvil exits;
4. checks every pin on the fork: the code of the vault, entrypoint, keystore and ASP registry (each proxy's
   code hash, its EIP-1967 implementation and that implementation's code hash), their wiring (the vault's
   keystore and ASP registry, the entrypoint's vault, all equal to the target's addresses), the deposit
   verifier, the 1x1 verifier route and that verifier's code hash, the Aztec registry's rollup, version,
   Inbox (and its code hash) and Outbox; and that both verifiers embed the target's bundle keys;
5. reads the same bindings and wiring live at the endpoint's finalized block;
6. prepares the fork: a fresh user mints USDC, registers, deposits and has its label approved by a mock ASP
   posting as the registry's postman; a fresh `PortalFactory` creates the USDC portal and opens entries; one
   spend to the portal is proved, and the deployed 1x1 verifier must accept it;
7. runs the four `PortalFork.t.sol` cases with Forge's `fork` profile in an environment built here, after
   checking that profile resolves to no ffi, no RPC storage cache and read access to `out/fork` alone; it
   passes only when `PortalForkTest` alone ran those four, each passed, and Forge exited 0;
8. tears down, and fails if any process group, port row (the mock ASP's included), data or fixture
   directory is left.

The whole run has a 10-minute deadline; past it, it fails and tears down. `run --prepare-only` stops after
step 6. A pass means compatible at the pinned block. Failures name their kind: `endpoint` (it no longer
serves the block: use another), `pin` (the endpoint or the fork disagrees with a pin), `live` (the deployment
moved after the pinned block: refresh the pins as `src/pins.ts` describes).

## The code tripwire

The operator's pool is upgradeable and its current build is unpublished, so a pass holds for the pinned
code hashes only. Every upgrade of one of the four contracts fails the next run, named as
`code.<contract>.<field>` with both values (kind `live` once the pinned block is behind it). Another package
checks the same hashes with the same reads through `@pp/sepolia-fork/pins`, which loads only viem:
`TARGETS`, `readPoolCode(client, pool, blockNumber)` (any viem `PublicClient` serves as the client, which
must answer every call at that block or throw) and `codeMismatches(want, got)`. A refresh (`pins <block>`)
refuses a block that is not finalized, empty code, a cleared slot or 1x1 route, wiring that names other
contracts, and a proxy whose code differs from the pinned one: a new proxy needs its dispatch reviewed and
its pin edited by hand first. Two more subpaths serve `@pp/testnet`'s rehearsals: `./anvil` (the pinned
anvil, its client version and a fork this run owns) and `./rpc` (a bare JSON-RPC client).

What a pass does not cover:
- The finalized block lags the head by about 15 minutes, so an upgrade can land between the compared block
  and a later transaction, and an upgrade undone between two runs leaves no trace.
- `PoolCode` is code, not configuration: verifier routes, ASP roots and roles can change behind equal
  hashes. The suite pins the deposit verifier and the 1x1 route itself; `readPoolCode` does not read them.
- One endpoint serves both the fork and the live reads; a pinned block hash does not authenticate the state
  it returns. Check a refreshed block's hash on a second endpoint.

Anvil 1.7.1 takes the endpoint only in argv, where other local users can read it, and `anvil_nodeInfo`
returns it to any client of the fork. That is acceptable for a keyless public endpoint only. Messages
name the endpoint's host, never its path or query.

## Tests

| Command | What |
|---|---|
| `bun run test` | Unit: pins, the code reader and its mismatch names, the shared entry's viem-only imports, the preflight's verdicts on a fake chain (an upgrade, one that drops a getter, a rewiring, every read at the checked block, and the refreshes refused), the verifier key check, a refused cache, host-only messages and rate-limit retries, the writer guard, the CLI's skip, usage and failure lines, the Foundry resolver, Forge's environment, profile and named-case checks, and the deadline's teardown. |
| `bun run test:net` | With `SEPOLIA_RPC_URL` set: a preflight run per target, a mutated Inbox pin and a mutated block hash failing on their pins with nothing left behind, the pre-ceremony bundle against SDK 1.0.0's published manifest, and a cached circuit file one byte short refused by name. Skipped when unset. |
