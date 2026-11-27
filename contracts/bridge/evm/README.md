# Bridge L1 contracts (Foundry)

L1 contracts for the ERC-20 bridge. Aztec L1 interfaces resolve to the installed
`@aztec-foundation/l1-artifacts` sources via the `@aztec/` remapping in `foundry.toml`, at the version
`packages/bridge-core` pins; no `aztec-contracts` submodule.

## Dependencies (not committed)

Foundry **1.7.1** and halmos **0.3.3** (`halmos.version`). A newer Foundry routes test-contract
creation through a cheatcode halmos 0.3.3 lacks, and every proof fails. `lib/` is gitignored; install
it at the commits CI pins. OpenZeppelin 5.7.0 provides `Clones.cloneDeterministicWithImmutableArgs`
and `ReentrancyGuardTransient`.

```bash
bash scripts/install-libs.sh
```

## Build / test

The `@aztec/` remap resolves through `packages/bridge-core`'s installed `@aztec-foundation/l1-artifacts`.
Under the repository's isolated linker that package is not at the root `node_modules` the static
`foundry.toml` remap assumes, so generate the override file first (gitignored). CI and the sandbox's
forge step generate it too.

```bash
# from the repository root:
bun packages/bridge-core/scripts/gen-remappings.ts        # writes contracts/bridge/evm/remappings.txt
(cd contracts/bridge/evm && forge build && forge test --no-match-contract Fork)
bash contracts/bridge/evm/scripts/check-gas.sh             # .gas-snapshot within 2%, every case ran
bash contracts/bridge/evm/scripts/check-halmos.sh          # every proof, by name, and the harness check
bash contracts/bridge/evm/scripts/check-invariant.sh       # invariant campaigns, with their reach checked
bash contracts/bridge/evm/scripts/nightly.sh               # the nightly profile: deep fuzz and invariants
```

## Contracts

- **`PortalFactory`** creates one **processor-portal clone per ERC-20** (OZ `Clones` with the token
  as an immutable arg, salt = the token address) and sends the L2 hub a `register` message carrying
  `(token, portal, nameWord, symbolWord, decimals)`. Idempotent and permissionless; the factory is
  the message's L1 sender. One generation binds one Privacy Pools vault and one per-clone lifetime
  cap. Its owner is the **guardian**: one entry pause (a delay, never a transfer of funds) behind
  `Ownable2Step`, renounce disabled. Entries start paused: nothing can sweep a clone, so a spend
  accepted by a generation bound to the wrong hub or vault would be stuck for good, and the guardian
  opens entries only once the bindings check out (bridge-core's `assertGenerationBindings`, with the
  rollup endpoints from `rollupEndpointsOf`) **and** the hub at `L2_HUB` is deployed from the v1 hub
  artifact. A hub that claims only the legacy messages cannot credit a v1 bridge, so its spend would
  be stuck the same way.
- **`ProcessorPortalImpl`** is the implementation every clone delegates to: the vault, the cap and
  the Aztec Inbox, Outbox and version are its immutables, and each clone's only storage is two
  counters, `grossAccepted` and `totalPaid`. `bridgeFromPool` spends one pool note into the clone
  (1×1 shape, this token, under the cap, exact receipt) and sends its value to the hub;
  `settleRagequit` and `settlePublicExit` pay a proven exit, never more than
  `grossAccepted − totalPaid`, in any pause state. Payloads come from `BridgeMessageV1`.
  `IPrivacyPoolVault` declares the vault's `transact`, its selector pinned to the pool's build.
- `MintableERC20` / `TestUsdc` are capped-mint test tokens; the local network deploys
  `MintableERC20` (see INFO-1).

## Tests

Hermetic forge tests (`forge test --no-match-contract Fork`), **12 halmos proofs**
(`FormalFactoryTest 2 · FormalProcessorPortalTest 10`; each guard-shaped proof carries a forge canary
showing the property fails without the guard), and a committed `.gas-snapshot` for `createPortal` on
a fresh token, `bridgeFromPool` and both settles. Fuzz runs 256 times and invariant campaigns run 256
runs at depth 100 by default; the `nightly` profile raises fuzz to 5,000 runs and depth to 500.

halmos cannot run sha256, so the portal proofs drive `ProcessorPortalHarness`, whose content hash is
keccak. Three things keep it honest: `PortalVectors` checks the production hash against the shared
vectors, `HarnessParity` fuzzes the same calls into a production and a harness clone and requires
identical outcomes, and `scripts/check-harness.py` (run by `check-halmos.sh`) requires equal selectors
and storage and a harness that declares nothing but a forwarding constructor and `_contentHash`.

| Layer | Suites |
|---|---|
| unit | `PortalFactory`, `ProcessorPortal`, `SettleRealOutbox` (both settles against Aztec's real `Outbox`: one payment per `(epoch, leafId)`, replay across a longer proof, identical exits as distinct tickets, tag and clone separation, reverting and surcharging payouts), `HarnessParity`, `PortalVectors` (the clone's wire envelope against the shared vectors), `BridgeMessageV1` (the v1 wire format against `packages/bridge-spec/vectors/v1.json`), `Keystone` (3-way vectors with Noir and TS), `MintableERC20`, `TestUsdc` |
| fuzz | `PortalFactoryFuzz`, `ProcessorPortalFuzz` (every refusal over its input range, with nothing moved) |
| invariant | `PortalFactoryInvariant`, `ProcessorPortalInvariant` (two clones on the real `Outbox` with the handler as rollup: honest, forged and replayed exits, every vault mode including reentry, donations, pause flips; payouts checked per payee; `check-invariant.sh` requires non-zero campaign counts of Outbox-refused replays, landed forged payouts, cap hits, reserve hits and guard hits, and both gate scripts clear every `FOUNDRY_*` and legacy `DAPP_*` variable but `FOUNDRY_PROFILE` and require every `invariant_` and `testFuzz` under `test/` to have run) |
| symbolic | `FormalFactory`, `FormalProcessorPortal` (on a keccak harness); see each header for what halmos can and cannot model (it has no sha256, so `createPortal` itself is forge-only) |
| adversarial | `BlackhatFactory` (F-1…F-9; F-7 and F-9 against the processor portal) |
| gas | `PortalGas` |

## Threat model: the factory-bound portal

What a clone trusts: the factory it was cloned from (immutable `FACTORY = msg.sender`, whose entry
pause it reads), the Aztec registry the factory bound at construction (Inbox, Outbox and version are
implementation immutables), and its own token (an immutable arg in its bytecode: nothing to
repoint, no initializer to front-run). What the factory reads from a token is sampled once,
gas-capped and bounded: a hostile `name()`/`symbol()` can only poison the two cosmetic words
(sanitized to printable ASCII, frozen at creation, never trusted for anything but display), a
missing `decimals()` refuses the portal, and a front-runner creating a token's portal first produces
the byte-identical portal, registration and message the honest caller would have (`BlackhatFactory`
F-1…F-8). The remaining trust is the guardian: the entry pause is unbounded in time by design and
can keep entries closed indefinitely, but never moves funds and never blocks an exit.

## Value-token hard-blockers (must clear before any deployment with value)

- **INFO-1: `MintableERC20` / `TestUsdc` are not value tokens.** `mint` is permissionless (capped per
  tx), and `MintableERC20` additionally treats every holder as having granted the canonical Permit2
  address an infinite allowance (`TestUsdc` does not). A value deployment must use a token with
  access-controlled mint and no forced allowance.
- **Only plain ERC-20s are supported**: the clone's reserve accounting assumes exact transfers both
  ways and a static balance, so rebasing and fee-on-transfer tokens are out.
