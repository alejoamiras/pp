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
bash contracts/bridge/evm/scripts/check-halmos.sh          # the four proofs, by name
```

## Contracts

- **`PortalFactory`** creates one storage-less **portal clone per ERC-20** (OZ `Clones` with the token
  as an immutable arg, salt = the token address) and sends the L2 hub a `register` message carrying
  `(token, portal, nameWord, symbolWord, decimals)`. Idempotent and permissionless; the factory is
  the message's L1 sender. Its owner is the **guardian**: two pause bits (deposits, withdrawals; a
  delay, never a transfer of funds) behind `Ownable2Step`, renounce disabled.
- **`TokenPortalImpl`** is the implementation every clone delegates to. Canonical `TokenPortal`
  content hashes byte for byte (`ContentHash.t.sol` and the Noir keystone), plus guards that never
  touch the hashed preimage: pause bits, `amount ≤ uint128.max`, exact-in (fee-on-transfer refused),
  exact portal debit on withdraw, a transient reentrancy guard. No storage, no initializer.
- `MintableERC20` / `TestUsdc` are capped-mint test tokens; the local network deploys
  `MintableERC20` (see INFO-1).

## Tests

Hermetic forge tests (`forge test --no-match-contract Fork`), **4 halmos proofs**
(`FormalFactoryTest 2 · FormalCloneTest 2`; each guard-shaped proof carries a forge canary showing
the property fails without the guard), and a committed `.gas-snapshot` for `createPortal` on a
fresh token, both deposits and `withdraw`.

| Layer | Suites |
|---|---|
| unit | `PortalFactory`, `CloneWithdrawRealOutbox` (a clone against Aztec's real `Outbox`: replay, caller binding, cross-clone proofs; the other suites' capturing fake accepts anything), `Keystone` (3-way vectors with Noir and TS), `ContentHash`, `BridgeMessageV1` (the v1 wire format against `packages/bridge-spec/vectors/v1.json`), `MintableERC20`, `TestUsdc` |
| fuzz | `PortalFactoryFuzz`, `CloneRoundtripFuzz` |
| invariant | `PortalFactoryInvariant` |
| symbolic | `FormalFactory`, `FormalClone`; see each header for what halmos can and cannot model (it has no sha256, so `createPortal` itself is forge-only) |
| adversarial | `BlackhatFactory` (F-1…F-9) |
| gas | `PortalGas` |

## Threat model: the factory-bound portal

What a clone trusts: the factory it was cloned from (immutable `FACTORY = msg.sender`, whose pause
bits it reads), the Aztec registry the factory bound at construction (Inbox, Outbox and version are
implementation immutables), and its own token (an immutable arg in its bytecode: nothing to
repoint, no initializer to front-run). What the factory reads from a token is sampled once,
gas-capped and bounded: a hostile `name()`/`symbol()` can only poison the two cosmetic words
(sanitized to printable ASCII, frozen at creation, never trusted for anything but display), a
missing `decimals()` refuses the portal, and a front-runner creating a token's portal first produces
the byte-identical portal, registration and message the honest caller would have (`BlackhatFactory`
F-1…F-8). The remaining trust is the guardian: a pause is unbounded in time by design and can
freeze deposits or withdrawals indefinitely, but never moves funds.

## Value-token hard-blockers (must clear before any deployment with value)

- **INFO-1: `MintableERC20` / `TestUsdc` are not value tokens.** `mint` is permissionless (capped per
  tx), and `MintableERC20` additionally treats every holder as having granted the canonical Permit2
  address an infinite allowance (`TestUsdc` does not). A value deployment must use a token with
  access-controlled mint and no forced allowance.
- **Rebasing tokens are unsupported** (the clone's reserve accounting assumes a static balance);
  fee-on-transfer tokens are refused on chain.
