# AGENTS.md

How to work in this repository, for people and agents. [`README.md`](README.md) says what it is.

## Layout

| Path | What it is |
|---|---|
| [`apps/web`](apps/web/README.md) | `@pp/web`: the label bridge's React app, on a fixture world until the real adapters land; `e2e/` holds its browser specs. |
| [`contracts/bridge/evm`](contracts/bridge/evm/README.md) | L1 contracts (Foundry): `PortalFactory` and the per-token `TokenPortalImpl` clones. |
| [`contracts/bridge/aztec`](contracts/bridge/aztec/README.md) | L2 contracts (Noir): `TokenBridgeHub`, the labelled token and its test minter, the hashing libraries and the TXE runner. |
| [`contracts/crates.json`](contracts/crates.json) | Every Noir crate, the gates it runs (parity, nargo tests, TXE) and the commit each git dependency tag must resolve to; `scripts/ci-cd/crates.ts` reads it. |
| [`packages/bridge-core`](packages/bridge-core/README.md) | `@pp/bridge-core`: claim, exit and readiness logic over viem and aztec.js, and the local-network harness (`scripts/sandbox/`). |
| [`packages/bridge-spec`](packages/bridge-spec/README.md) | `@pp/bridge-spec`: the normative v1 wire format and hashes in TS, and the vectors that bind `BridgeMessageV1` (Solidity) and `bridge_message`/`pp_hash` (Noir) to it. |
| [`packages/e2e-kit`](packages/e2e-kit/README.md) | `@pp/e2e-kit`: the Playwright kit `apps/web` runs on (test wallet, injected Ethereum wallet, egress fence, runner). |
| [`packages/label-paths`](packages/label-paths/README.md) | `@pp/label-paths`: browser-safe ASP snapshots, label paths, `labelState`, and a keyless reader of the registry's record. |
| [`packages/labelled-token`](packages/labelled-token/README.md) | `@pp/labelled-token`: the labelled token's artifact (browser-safe root), its gate budgets, the hub's derivation vector and its two-device network suite. |
| [`packages/local-stack`](packages/local-stack/README.md) | `@pp/local-stack`: `bun run demo`, one anvil carrying the Aztec local network and the pool, with its manifest and heartbeat. |
| [`packages/asp-bot`](packages/asp-bot/README.md) | `@pp/asp-bot`: posts the ASP root to the Aztec registry and serves the snapshots, as a child process group. |
| [`packages/pool-client`](packages/pool-client/README.md) | `@pp/pool-client`: Privacy Pools v2 notes and a checked one-input spend to a processor, in Node, Bun and the browser; never submits. `@pp/pool-client/testing` seeds a running `pp-env up`. |
| [`packages/run-isolation`](packages/run-isolation/README.md) | `@pp/run-isolation`: the primitives a local run uses to own its ports and processes: the host port registry and its lock, group-leader children that end with the process that spawned them and their teardown, and `./process-group`, which tells a running group from one of unreaped zombies. Node-only, no dependencies. |
| [`scripts/`](scripts) | CI-gating tests (`scripts/ci-cd/`), the complexity baseline, the absolute-path guard. |
| [`.github/`](.github) | PR workflows, each with a `changes` filter and an exact-state aggregator. |

Every workspace is private; nothing is published. Plans and audit records are kept outside this
repository.

## Toolchain

- **Bun 1.4.2** (`package.json#packageManager`, the `setup-bun` action). `bun.lock` is lockfile v3, which the
  scoped `overrides` entry needs.
- **Aztec 6.0.0.** `@aztec-labs/*` and `@aztec-foundation/*` are exact-pinned; the CLI lives at
  `~/.aztec/versions/6.0.0/`. Call that path, never `~/.aztec/current`, which other tools repoint.
  [`UPDATE.md`](UPDATE.md) lists what a bump touches.
- **Foundry 1.7.1 and halmos 0.3.3** for the L1 suites. Newer Foundry fails every halmos proof
  (setUp goes through a cheatcode halmos 0.3.3 lacks), so keep these two on your `PATH` for
  `contracts/bridge/evm`. The forge that Aztec bundles is used only to build the sandbox's
  deploy artifacts.

## Fast loop

Run from the repository root. Times are wall-clock on a fresh worktree of a 192-core Linux host,
with warm package and toolchain caches.

| Layer | Command | Time |
|---|---|---|
| Install | `bun install --frozen-lockfile` | 4 s |
| Lint (Biome + complexity) | `bun run lint` | < 1 s |
| Typecheck | `bun run typecheck:all` | 23 s |
| Unit (every workspace) | `bun run test:all` | 16 s |
| CI-gating tests | `bun run test:ci-gating` | < 1 s |
| Workflow lint | `bun run lint:actions` | < 1 s |
| Quality and Web build without the pool checkout | `bun run test:unfetched` | 3 min |
| L1 build + hermetic tests | `forge build && forge test --no-match-contract Fork` in `contracts/bridge/evm` | 2 min |
| L1 gas snapshot | `bash contracts/bridge/evm/scripts/check-gas.sh` | 1 s |
| L1 symbolic proofs | `bash contracts/bridge/evm/scripts/check-halmos.sh` | 67 s |
| L2 artifact parity | `bash contracts/bridge/aztec/scripts/compile.sh --check` | 76 s |
| L2 TXE suite | `bash contracts/bridge/aztec/scripts/run-txe-tests.sh` | 3.5 min |
| L2 nargo tests + pinned commits | `bun scripts/ci-cd/crates.ts nargo-test && bun scripts/ci-cd/crates.ts check-pins` (keystone requires every v1 test by name) | 52 s |
| Labelled token TXE | `bash contracts/bridge/aztec/scripts/run-txe-tests.sh --crate labelled_token` | 3 min |
| Labelled token gates | `bun run --cwd packages/labelled-token gates:check` | 4 s |
| Labelled token fixtures | `bun run --cwd packages/labelled-token fixtures:check` | 27 s |
| Wire-format vectors | `bun run --cwd packages/bridge-spec vectors:check`, then `vectors:mutate -- --suite ts\|sol\|nr` | < 1 s, then 3 s · 5 s · 45 s |
| Sole consumer | `bash contracts/bridge/aztec/scripts/check-sole-consumer.sh` | < 1 s |
| Integration (local network) | `bun run --cwd packages/bridge-core test:integration` | 10 min |
| Sandbox smoke | `bun run --cwd packages/bridge-core sandbox:smoke` | 7.5 min |
| Labelled token, two devices | `bun run --cwd packages/labelled-token test:net` | 6.5 min |
| Labelled token proving bench | `bun run --cwd packages/labelled-token bench:prove` (real prover; run it alone on the host) | 5 min |
| Local stack | `bun run demo` (`--keep` holds it up) | 44 s (ready in 40 s) |
| Local stack integration | `bun run --cwd packages/local-stack test:integration` | — |
| E2E kit build | `bun run --cwd packages/e2e-kit build:test-wallet` (see its README for inputs) | 15 s |
| Pool client, unit | `bun run --cwd packages/pool-client test` and `test:node` | 10 s |
| Web e2e (sandbox boot, both builds, Playwright) | `bun run --cwd apps/web e2e` | 4 min |
| Pool client, against a local pool | `bun run --cwd packages/pool-client test:integration:node`, `test:browser`, `test:browser:integration` (after pp-env's `fetch`) | 35 s · 45 s · 30 s |

After any change: lint, typecheck and the unit tests of the touched package. Before a PR: every row
the change can reach. CI runs the same commands in `pr-quick.yml`, `bridge-contracts.yml`,
`pool-client.yml`, `actionlint.yml` and `web.yml`.

Quality's jobs and Web's build job never fetch the pool checkout, so a worktree that ran pp-env's
`fetch` resolves `#ppv2` where CI cannot. Before a PR whose code can reach `@pp/pp-env`, run
`bun run test:unfetched`: it runs those jobs' steps with this worktree's checkout link moved aside,
so run one at a time per worktree.

Suites too slow for a pull request go in `SUITES` in [`scripts/nightly.ts`](scripts/nightly.ts)
(`bun run nightly`). `nightly.yml` runs it every day from `bridge-v1` when that branch exists, else
`main`, so a lane adds its deep suite in its own branch; dispatch the workflow with a `ref` to test
another, and with `suites` (names separated by spaces) to run only those. A suite that passes no
test fails. A failed run keeps the real-wallet tier's reports and logs as an artifact for three
days. The L1 fuzz and invariant suites are
`contracts/bridge/evm/scripts/nightly.sh` at that package's `nightly` Foundry profile; local-stack's
32-minute idle case is its `test:integration:long`.

## Working in this repo

- **The linker is `isolated`** (`bunfig.toml`). A workspace resolves only what its `package.json`
  declares; an undeclared import can still resolve locally through the store's hoist fallback and
  then fail on CI's fresh runner. Declare every package a workspace imports, type-only imports
  included. Never walk `node_modules` by hand: `@nulo-sh/resolve-asset` resolves from the caller.
  [`packages/bridge-core/scripts/layout-identity.test.ts`](packages/bridge-core/scripts/layout-identity.test.ts)
  is the executable guarantee.
- **Unit tests run on Bun** (`bun --bun vitest run`). Every vitest config spreads `sharedTest` from
  [`vitest.base.ts`](vitest.base.ts); its `deps.interopDefault: false` is a stopgap for vitest 4
  mistaking Bun's ES-module namespaces for CommonJS. `bun:test` is for files that load no
  `@aztec-labs/*` package, directly or through a workspace: on a cold transpiler cache, which every CI
  runner has, it breaks `@aztec-labs/foundation` at import. `test:all`, `test:ci-gating` and the kit's
  runner set `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` so a local run starts cold too.
- **Biome** lints and formats. `noExplicitAny` is an error: use `unknown` and narrow.
- **Commits** are Conventional Commits with a lower-case subject, checked by the commit-msg hook and
  in CI. The pre-commit hook runs Biome on staged files, the absolute-path guard and the complexity
  baseline; `bun install` installs the hooks.
- **Complexity budgets** are Biome errors: cognitive complexity ≤ 15, ≤ 80 non-blank lines per
  production function. [`scripts/complexity-baseline/manifest.json`](scripts/complexity-baseline/manifest.json)
  holds the accepted exceptions (none today); the list only shrinks, and only
  `bun run baseline:complexity` writes it.
- **Local services are parallel-safe.** The sandbox claims its ports from the host registry
  `~/.agents/ports.md`, runs each child in its own process group, keeps data under `~/.cache/pp/`
  and tears down only what it started. Never stop a service by name. Process-group liveness and
  teardown come from `@pp/run-isolation`, not a new `process.kill` on a negative pid. Teardown is
  registered in hooks (`afterAll`, `onTestFinished`) or global setup, never only in a test body's
  `finally`, which vitest skips when it kills a timed-out worker.

## Branching and merging

- `main` is the only long-lived branch. Work lands through squash-merged pull requests; the PR
  title becomes the commit subject, so write it as a Conventional Commit of at most 93 characters.
  `commit-messages-status` lints "<title> (#<number>)" and the PR's own commits, never main's (a sync
  carries those), and re-runs on a title edit or a retarget.
- Pull-request workflows have no `branches:` filter, so CI runs whatever the base: `main`, an
  integration branch or a lower PR in a stack. `scripts/ci-cd/behavior-gating.test.ts` pins this.
- Required on `main`: `quality-status`, `bridge-contracts-status` and `actionlint-status`, each
  produced by an exact-state aggregator, plus signed commits.
- Renaming an aggregator blocks every merge until the protection follows it. Record the old → new
  pair in `RENAMES` (`scripts/ci-cd/required-checks.ts`), run
  `scripts/ci-cd/required-checks.sh print --branch main --json > <file>` and review it, then
  `scripts/ci-cd/required-checks.sh --apply --branch main --expect <file>` right before the merge.
  `scripts/ci-cd/behavior-gating.test.ts` pins each workflow's aggregator name.
- A red check is a flake to re-run or a break to fix. It is never made advisory, skipped, or removed
  from the required set to get a merge through.

## Dependency policy

- **7-day minimum release age** (`bunfig.toml`). A CVE fix newer than the gate goes in through a
  temporary `minimumReleaseAgeExcludes` entry that leaves in the same PR. The Nulo wallet's
  `@nulo-sh/*` packages are standing exemptions; no other name becomes one without the owner's
  decision. Details: [`SECURITY.md`](SECURITY.md).
- **The Aztec line is exact-pinned and bumped by hand** ([`UPDATE.md`](UPDATE.md)).
- **A dependency two workspaces share lives in a root catalog** (top-level, beside an array
  `workspaces`), and each workspace names it `catalog:`. The named `pool` catalog holds what must
  match the pool SDK checkout (its viem), for `catalog:pool`. The Aztec packages stay exact in each
  manifest.
  `scripts/ci-cd/aztec-line.test.ts` holds both rules.
- `bun audit` runs in CI as an advisory step. No Renovate: dependency bumps are manual PRs.

## Security

Treat every change as attack surface. A content hash, a secret derivation, a salt or an authwit
scope is protocol, and a change to one is reviewed as such. No key is needed to develop here: local
runs sign with anvil's well-known keys. Never commit a key, a `.env` with values or an absolute
local path. Security reports go through GitHub's private advisories ([`SECURITY.md`](SECURITY.md)).

## Code comments

Say what the code cannot: invariants, constraints, non-obvious reasons, external quirks. Never
narrate what a line does, and never cite a plan, phase, PR or review; git history carries
provenance. Public APIs get a TSDoc contract (parameters, invariants, failure modes) without filler.
