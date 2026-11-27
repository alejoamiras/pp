# @pp/sepolia-fork

The bridge's Ethereum side against the real Privacy Pools deployment on Sepolia (V8) and the real Aztec
testnet Inbox, with no L2. Everything runs on an anvil fork this suite owns; no transaction reaches a live
network.

## Use

```sh
SEPOLIA_RPC_URL=<public Sepolia endpoint with archive state> bun run --cwd packages/sepolia-fork run
```

The endpoint comes only from `SEPOLIA_RPC_URL`, with no default. Unset, `run` prints one skip line and
exits 0; `run --require-rpc` makes that a failure. The endpoint must serve state at the pinned block, so a
pruning node fails with "no longer serves block N". `bun run nightly sepolia-fork` runs it against the one
committed keyless gateway.

Prerequisites from a clean checkout: `bun install`, `bun run --cwd packages/pp-env fetch`,
`bash contracts/bridge/evm/scripts/install-libs.sh`, `bun packages/bridge-core/scripts/gen-remappings.ts`,
and `forge build` in `contracts/bridge/evm`, with Foundry 1.7.1 on `PATH` or in `~/.cache/pp/tools/`.

A run:

1. checks the endpoint serves Sepolia, the pinned block with its pinned hash, and state at that block;
2. fetches the pre-ceremony circuits at pool-client's pins (once, into `~/.cache/pp/fork/artifacts/`) and
   hashes every file again;
3. forks the endpoint with Foundry 1.7.1's anvil at the pinned block, on a claimed loopback port, as its own
   process group, which ends and frees its row even when the runner is SIGKILLed (Forge's groups too; the
   mock ASP's row and the run's data directory stay then, for removal by hand);
4. checks every pin on the fork: the vault's implementation and code hash, its deposit verifier, its 1x1
   verifier route and that verifier's code hash, the Aztec registry's rollup, version, Inbox (and its code
   hash) and Outbox; and that both verifiers embed the pre-ceremony keys;
5. reads the same bindings live at the endpoint's finalized block;
6. prepares the fork: a fresh user mints USDC, registers, deposits and has its label approved by a mock ASP
   posting as the registry's postman; a fresh `PortalFactory` creates the USDC portal and opens entries; one
   spend to the portal is proved, and the deployed 1x1 verifier must accept it;
7. runs the four `PortalFork.t.sol` cases with Forge's `fork` profile in an environment built here, after
   checking that profile resolves to no ffi and read access to `out/fork` alone;
8. tears down, and fails if any process group, port row or data directory is left.

The whole run has a 10-minute deadline; past it, it fails and tears down. `run --prepare-only` stops after
step 6. A pass means compatible at the pinned block. Failures name their kind: `endpoint` (it no longer
serves the block: use another), `pin` (the endpoint or the fork disagrees with a pin), `live` (the deployment
moved after the pinned block: refresh the pins as `src/pins.ts` describes).

Anvil 1.7.1 takes the endpoint only in argv, where other local users can read it, and `anvil_nodeInfo`
returns it to any client of the fork. That is acceptable for a keyless public endpoint only. Messages
name the endpoint's host, never its path or query.

## Tests

| Command | What |
|---|---|
| `bun run test` | Unit: pins, the preflight's verdicts on a fake chain, the verifier key check, a refused cache, host-only messages and rate-limit retries, the writer guard, the CLI's skip and failure lines, the Foundry resolver, Forge's environment, profile and named-case checks, and the deadline's teardown. |
| `bun run test:net` | With `SEPOLIA_RPC_URL` set: a preflight run, a mutated Inbox pin and a mutated block hash failing on their pins with nothing left behind, the bundle against SDK 1.0.0's published manifest, and a cached circuit file one byte short refused by name. Skipped when unset. |
