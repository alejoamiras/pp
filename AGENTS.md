# AGENTS.md

How to work in this repository, for people and agents. [`README.md`](README.md) says what it is.

## Layout

| Path | What it is |
|---|---|
| [`contracts/bridge/evm`](contracts/bridge/evm/README.md) | L1 contracts (Foundry): `PortalFactory` and the per-token `TokenPortalImpl` clones. |
| [`contracts/bridge/aztec`](contracts/bridge/aztec/README.md) | L2 contracts (Noir): `TokenBridgeHub`, its hashing libraries and the TXE runner. |
| [`packages/bridge-core`](packages/bridge-core/README.md) | `@pp/bridge-core`: claim, exit and readiness logic over viem and aztec.js, and the local-network harness (`scripts/sandbox/`). |
| [`packages/e2e-kit`](packages/e2e-kit/README.md) | `@pp/e2e-kit`: the Playwright kit a web app under `apps/` will use (test wallet, injected Ethereum wallet, egress fence, runner). |
| [`scripts/`](scripts) | CI-gating tests (`scripts/ci-cd/`), the complexity baseline, the absolute-path guard. |
| [`.github/`](.github) | PR workflows, each with a `changes` filter and an exact-state aggregator. |

Every workspace is private; nothing is published. Plans and audit records are kept outside this
repository.

## Toolchain

- **Bun 1.4.2** (`package.json#packageManager`, the `setup-bun` action). `bun.lock` is lockfile v2.
- **Aztec 6.0.0.** `@aztec-labs/*` and `@aztec-foundation/*` are exact-pinned; the CLI lives at
  `~/.aztec/versions/6.0.0/`. Call that path, never `~/.aztec/current`, which other tools repoint.
  [`UPDATE.md`](UPDATE.md) lists what a bump touches.
- **Foundry 1.7.1 and halmos 0.3.3** for the L1 suites. Newer Foundry fails every halmos proof
  (setUp goes through a cheatcode halmos 0.3.3 lacks), so keep these two on your `PATH` for
  `contracts/bridge/evm`. The forge that Aztec bundles is used only to build the sandbox's
  deploy artifacts.

## Fast loop

Run from the repository root. Times are wall-clock on a 192-core Linux host, warm caches.

| Layer | Command | Time |
|---|---|---|
| Install | `bun install --frozen-lockfile` | — |
| Lint (Biome + complexity) | `bun run lint` | — |
| Typecheck | `bun run typecheck:all` | — |
| Unit (every workspace) | `bun run test:all` | — |
| CI-gating tests | `bun run test:ci-gating` | — |
| Workflow lint | `bun run lint:actions` | — |
| L1 build + hermetic tests | `forge build && forge test --no-match-contract Fork` in `contracts/bridge/evm` | — |
| L1 gas snapshot | `bash contracts/bridge/evm/scripts/check-gas.sh` | — |
| L1 symbolic proofs | `bash contracts/bridge/evm/scripts/check-halmos.sh` | — |
| L2 artifact parity | `bash contracts/bridge/aztec/scripts/compile.sh --check` | — |
| L2 TXE suite | `bash contracts/bridge/aztec/scripts/run-txe-tests.sh` | — |
| L2 hash vectors | `aztec-nargo test --force` in `contracts/bridge/aztec/keystone` | — |
| Sole consumer | `bash contracts/bridge/aztec/scripts/check-sole-consumer.sh` | — |
| Integration (local network) | `bun run --cwd packages/bridge-core test:integration` | — |
| Sandbox smoke | `bun run --cwd packages/bridge-core sandbox:smoke` | — |
| E2E kit build | `bun run --cwd packages/e2e-kit build:test-wallet` (see its README for inputs) | — |

After any change: lint, typecheck and the unit tests of the touched package. Before a PR: every row
the change can reach. CI runs the same commands in `pr-quick.yml`, `bridge-contracts.yml` and
`actionlint.yml`.

## Working in this repo

- **The linker is `isolated`** (`bunfig.toml`). A workspace resolves only what its `package.json`
  declares; an undeclared import can still resolve locally through the store's hoist fallback and
  then fail on CI's fresh runner. Declare every package a workspace imports, type-only imports
  included. Never walk `node_modules` by hand: `@nulo-sh/resolve-asset` resolves from the caller.
  [`packages/bridge-core/scripts/layout-identity.test.ts`](packages/bridge-core/scripts/layout-identity.test.ts)
  is the executable guarantee.
- **Unit tests run on Bun** (`bun --bun vitest run`). Every vitest config spreads `sharedTest` from
  [`vitest.base.ts`](vitest.base.ts); its `deps.interopDefault: false` is a stopgap for vitest 4
  mistaking Bun's ES-module namespaces for CommonJS.
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
  and tears down only what it started. Never stop a service by name.

## Branching and merging

- `main` is the only long-lived branch. Work lands through squash-merged pull requests; the PR
  title becomes the commit subject, so write it as a Conventional Commit of at most 93 characters.
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
