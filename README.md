# pp

A proof of concept that moves funds from Privacy Pools v2 on Ethereum into Aztec and keeps each
note's label. This tree is its baseline: an ERC-20 bridge between Ethereum and Aztec 6.0.0, with
its tests and CI gates. The pool processor, labelled notes and the web app build on it.

| Path | What it is |
|---|---|
| [`contracts/bridge/evm`](contracts/bridge/evm/README.md) | L1 contracts (Foundry): `PortalFactory` and the per-token portal clones that hold deposits and pay exits. |
| [`contracts/bridge/aztec`](contracts/bridge/aztec/README.md) | L2 contracts (Noir): `TokenBridgeHub` and the `LabelledToken` it derives per ERC-20, which it mints on a claim from a pool withdrawal and burns on a ragequit or a public exit. |
| [`packages/bridge-core`](packages/bridge-core/README.md) | Bridge logic over viem and aztec.js, and the local network its integration tests run on. |
| [`packages/e2e-kit`](packages/e2e-kit/README.md) | Playwright kit for the web app: a test wallet, an injected Ethereum wallet, an egress fence. |
| [`packages/local-stack`](packages/local-stack/README.md) | `bun run demo`: one anvil carrying the Aztec local network and the pool, booted and torn down as one stack. |
| [`packages/pool-client`](packages/pool-client/README.md) | Privacy Pools v2 client: a user's notes and a checked spend to a processor, in Node, Bun and the browser. |
| [`packages/run-isolation`](packages/run-isolation/README.md) | The port registry, lock and process-group primitives every local run claims and tears down with. |

## Run the gates

```bash
bun install                                         # Bun 1.4.2
bun run lint && bun run typecheck:all && bun run test:all
bun run demo:prepare                                # once per worktree: the pool checkout and the bridge contracts
bun run --cwd packages/bridge-core test:integration # boots and reaps its own local network
bun run --cwd packages/bridge-core test:hub         # the hub's own network suite, likewise
bun run --cwd packages/bridge-core test:integration:stack  # the whole stack suite on a demo stack it boots and stops
```

The contract suites need Foundry 1.7.1, halmos 0.3.3 and the Aztec 6.0.0 toolchain.
[`AGENTS.md`](AGENTS.md) lists every gate with its command and its measured time.

## Origin

Derived from [Unleashed](https://github.com/alejoamiras/unleashed) at commit `4d53adc`; see
[`NOTICE`](NOTICE). Apache-2.0, see [`LICENSE`](LICENSE).
