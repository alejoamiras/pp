# @pp/e2e-kit

The Playwright kit the web app in `apps/web` is driven with: a real Chromium against a real local
network, with a wallet that is not a product wallet. It holds an `@aztec-labs/wallets` embedded
wallet behind `@aztec-labs/wallet-sdk`'s iframe handler (`test-wallet/`) and an injected EIP-1193 L1
wallet answered from Node (`fixtures/l1-wallet.ts`). The specs live in `apps/web/e2e`;
`bun run --cwd apps/web e2e` runs this kit.

```bash
bun run --cwd packages/e2e-kit test:browser                    # everything, one sandbox
PP_E2E_MODE=stack bun run --cwd packages/e2e-kit test:browser  # everything, one local stack
bun run --cwd packages/e2e-kit test:browser -- --shard=1/2     # a shard (each boots its own network)
bun run --cwd packages/e2e-kit test:browser reap               # stop networks this checkout left behind
```

`scripts/e2e/agent.sh` is the whole run:

1. Claim three ports from `~/.agents/ports.md`: the app and one wallet origin per profile.
2. Boot the network. `sandbox` mode (the default): `sandbox:up` from `packages/bridge-core`
   (anvil, `aztec start --local-network`, a bridge generation). `stack` mode: `scripts/e2e/stack.ts
   up`, which starts `@pp/local-stack`'s CLI (`demo --keep`) as its own process group and waits for
   its manifest.
3. `build:test-wallet` with the run's node and app origin baked in.
4. The app's `build:local` with the wallet URLs and either the sandbox artifacts (the fixture world)
   or the stack's `PP_STACK_MANIFEST`, then a check that both bundles name the node, then
   Playwright with one server per build: `vite preview` for a fixture build, the app's own `serve`
   for a stack build.
5. Reap.

State lives under `.e2e-state/<run>/` (gitignored), or `PP_E2E_STATE_DIR` when set: ports, the
network's artifacts, both builds, logs, traces. `PP_E2E_KEEP=1` keeps the network and prints the line that reattaches to it
(`PP_E2E_ATTACH=<state dir>`, with `PP_E2E_REBUILD=1` to rebuild); a network whose boot failed or was interrupted is never kept.

## Stack mode

`bun run --cwd apps/web e2e` runs this mode; it needs what `bun run demo` needs (`bun run
demo:prepare` once per clone, Foundry 1.7.1 or `FORGE` pointing at it). `stack.ts up` writes
`<state>/stack.json` (the CLI's process group, the manifest path, the circuits directory the CLI
printed, the anvil indices of the stack's seeded pool user and bridge sender; never a key) and
`<state>/wallet/handle.json`, the node, chain and rollup version the test wallet builds from. The
app's own server gets that circuits directory as `PP_CIRCUITS_DIR`, and `up` fails at a ready line
the circuits line did not precede. From the spawn on, `<state>/stack.pid` records the
group and its leader's start time. `stack.ts down` sends SIGTERM to that group only while its
leader still has that start time and runs the CLI, and waits up to three minutes: the CLI tears
down every group it started itself, which SIGKILL would orphan. A live group led by anything else
is left alone, and so is its record. `reap` runs `down` for every stack state under `.e2e-state/`
and under `PP_E2E_STATE_DIR`; a state's ports go back to the registry only once its `stack.pid` is gone.

On the stack, `Network.l1(0)` is the seeded pool user and `l1(1)` its sender, the stack runs its own
block heartbeat, and actors are sponsor-deployed through bridge-core's `connectL2` and
`createActor`. A spec reads `run.mode` to skip what one mode cannot show.

## Layout

| Path | Role |
|---|---|
| `playwright.config.ts` | Chromium, `workers: 1`, the app and wallet servers, traces on failure; specs come from `apps/web/e2e` or `PP_E2E_SPECS` |
| `env.ts` | the run's coordinates from the `PP_*` variables the runner sets, its mode, and the stack run record |
| `global-setup.ts` | the handle or the stack manifest names chain 31337 |
| `fixtures/test.ts` | the `test` every spec uses: network access, an actor pool per file, a fresh actor per test, the L1 shim, the egress fence, the parked wallet panel |
| `fixtures/network.ts` | the run's network for either mode: `newActor()`, the L1 account by index, the sandbox's block nudge |
| `fixtures/sandbox.ts` | the sandbox's Node side: `openSandbox` on the handle, `newActor()` (sponsor-deployed, with its own flow context) |
| `fixtures/l1-wallet.ts` | `window.ethereum` → `exposeFunction` → viem over anvil: `setChainId`, `setAccount`, `rejectNext`, `holdNext(kind, { to })`, per-method `calls` |
| `fixtures/egress.ts` | aborts every non-loopback request; the record must be empty at teardown |
| `fixtures/wallet-panel.ts` | parks the SDK's floating session panel in a corner so it covers no test id |
| `fixtures/build-artifacts/handle.json` | placeholder handle for the build-only CI job; names no live network and holds no key |
| `test-wallet/` | the wallet page: `profile.ts`, `wallet.ts` (embedded wallet, grant, wallet-specific RPCs), `main.ts` (the handler and the control hook `window.__ppTestWallet`), its own `vite.config.mts` |
| `shard-reporter.ts`, `scripts/e2e/shard-plan.ts` | under `--shard`, deal whole spec files by recorded duration instead of test count |
| `shard-durations.json` | the record `shard-plan.ts` reads; empty until the suite is sharded |
| `scripts/e2e/resolve-ports.ts` | claims and releases the run's ports in the host registry |
| `scripts/e2e/stack.ts` | stack mode's `up` and `down` for the local stack's CLI process group |

## Accounts

Actors are created in Node before the browser opens, `cells + 2` per file, capped at 16 per grant.
A context init script sets `window.__ppTestWalletSeeds` on the wallet origins only, so the app page
never sees a seed. The wallet imports every seed before it answers `requestCapabilities`. A test
takes the next unused actor, a retry takes a spare, and no actor is reused.

## Profiles

- `plain`: a stock wallet-sdk wallet. Wallet-specific RPCs answer `Unknown wallet method`.
- `full`: loads `@nulo-sh/wallet-sdk-schema-patch` and answers `registerToken` and
  `isTokenRegistered`.

Each profile is served on its own loopback origin from the same build. The SDK's discovery probe
tells wallet frames apart by origin alone, so same-origin profiles answer each other's probe.

The wallet accepts only the app id `pp` and the sandbox's chain. Only the app origin may frame it
(CSP `frame-ancestors` and the handler's `allowedOrigins`).

## Control hook

`window.__ppTestWallet` on the wallet origin: `addAccount`, `calls`, `submitted`, `failNext`,
`holdNext` (park until `release`), `swallowNext` (run, never answer), `dropNextSubmission` (record
the transaction at the node hand-off, never forward it) and `declineNextGrant`.

## Blocks come on demand

The local network builds a block only when a transaction arrives, so a claim driven from the UI
would wait forever on an L1→L2 message. On the sandbox the `test` fixture keeps a heartbeat for the
worker's life, the same nudge the integration harness uses; the local stack keeps its own. This is
the one place the suite differs from a real network.

## CI

`pr-quick.yml` builds the test wallet against `fixtures/build-artifacts` on every change the kit can
see. `web.yml` runs the whole browser suite in stack mode, the local stack included, on every change
the app or the kit can see.

## Real wallet

`bun run --cwd packages/e2e-kit test:real-wallet [-- <playwright args>]` runs
`apps/web/e2e/real-wallet.pw.ts` against the pinned public release of the wallet, approving in its
own windows. `real-wallet/run.ts` gives the run a fresh state directory (a `mkdtemp` child of
`PP_E2E_STATE_DIR`, else of `.e2e-state/`), runs `agent.sh` with `PP_E2E_WALLET=real`, then fails
if a listener, a port row, a browser process or the `real-wallet/` directory of the run survives.
Playwright's output ends with `real-wallet: N/4 passed as expected`.

- **Pins.** `real-wallet/wallet-pin.json` (zip URL, size, sha256, provenance) and
  `real-wallet/crs-pin.json` (the proving points' compressed ranges and the decompressed G1). Bump
  the wallet with `bun real-wallet/pin-wallet.ts <tag>`, which needs `gh`, refuses a prerelease or a
  release under seven days old, and checks the build attestation against the tag's commit.
  Re-measure the points with `bun real-wallet/crs.ts --pin` when bb.js changes.
- **Fence.** Chromium's proxy is a recorder that refuses everything; only the run's own
  `127.0.0.1` ports bypass it. The proxy and resolver rules are in force from process start. The
  canaries are the fixture's first action on each launch, before it drives the app page or any
  wallet page; they check the fence, they do not establish it: a remote host and an unowned
  loopback port both reach the recorder, that port's listener sees nothing, an owned probe answers.
  Every refused host must be listed in `real-wallet/declared-refusals.json`, and listed hosts stay
  refused; any other host fails the test that tried it. A new profile starts on Mainnet, so the
  wallet's first requests go to the Mainnet node and its relay, which the fence refuses.
- **Proving points.** Node downloads the exact pinned ranges from the Aztec CDN, checks them,
  decompresses G1 with bb.js's WASM backend and checks the result. A launch of its own writes them
  into the wallet's IndexedDB; the test launch reads them back at their pinned hashes before onboarding.
- **Secrets.** The wallet's password is random per run and never written; its recovery phrase is
  the wallet's own, made per run. A trace of a wallet window may show either. Both are worthless
  outside the run, and the profile is deleted at teardown.

Known limits:

- Chromium's sandbox needs unprivileged user namespaces. Where AppArmor restricts them (Ubuntu
  23.10 and later with `kernel.apparmor_restrict_unprivileged_userns=1`, as on the agents' Linux
  host) the suite runs without it, after the canaries pass; no host setting is changed to get it.
- A Playwright worker killed with SIGKILL can leave Chromium running: a persistent context exposes
  no pid. `run.ts` reports it; nothing kills by name.

## Rules

- Selectors are `data-testid` only, narrowed by `data-*` attributes on the same element where an id
  repeats.
- Every test states its expected payer and its balance or note postconditions, read from the chain
  through the harness; the UI's text is never the authority.
- Nothing here boots a network or picks a port by hand; the runner owns both. Two runs on one
  machine are two networks on two port sets.
