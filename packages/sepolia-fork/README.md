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
pruning node fails with "no longer serves block N".

A run:

1. checks the endpoint serves Sepolia, the pinned block with its pinned hash, and state at that block;
2. forks it with Foundry 1.7.1's anvil at the pinned block, on a claimed loopback port, as its own process group;
3. checks every pin on the fork at that block: the vault's implementation and code hash, its deposit
   verifier, its 1x1 verifier route and that verifier's code hash, and the Aztec registry's rollup,
   version, Inbox (and its code hash) and Outbox;
4. reads the same bindings live at the endpoint's finalized block;
5. tears down, and fails if any process group, port row or data directory is left.

A pass means compatible at the pinned block. Failures name their kind: `endpoint` (it no longer serves the
block: use another), `pin` (the endpoint or the fork disagrees with a pin), `live` (the deployment moved
after the pinned block: refresh the pins as `src/pins.ts` describes).

Anvil 1.7.1 takes the endpoint only in argv, where other local users can read it, and `anvil_nodeInfo`
returns it to any client of the fork. That is acceptable for a keyless public endpoint only. Messages
name the endpoint's host, never its path or query.

## Tests

| Command | What |
|---|---|
| `bun run test` | Unit: pins, the preflight's verdicts on a fake chain, host-only messages and rate-limit retries, the writer guard, the CLI's skip and failure lines, the anvil resolver. |
| `bun run test:net` | With `SEPOLIA_RPC_URL` set: a full run, then a mutated Inbox pin and a mutated block hash, each failing on its pin with nothing left behind. Skipped when unset. |
