# @pp/bridge-core

Framework-agnostic L1↔L2 bridge logic in TypeScript over `viem` (L1) and `aztec.js` (L2), plus the
local-network harness that proves it. No UI framework, no server.

One **generation** per network: an L1 `PortalFactory` (one storage-less portal clone per ERC-20) and
one L2 `TokenBridgeHub` that registers a token from the factory's attested words and derives its L2
`Token`. Every derivable address (portal, hub, L2 token) is a pure function of that pair, and this
package re-derives it rather than trusting a file.

## Entry points

| Import | What |
|---|---|
| `@pp/bridge-core` | `src/index.ts`: claim, exit, readiness, hashes, secrets, journal. |
| `@pp/bridge-core/artifacts` | The committed hub artifact. |
| `@pp/bridge-core/sandbox` | `scripts/sandbox/`: boot a local network, deploy a generation, deposit, claim, exit. Also the generation manifest schema (`manifest-v2`), a per-run handoff. Node only. |

## File map (`src/`)

| File | Purpose |
|---|---|
| `hub-l2.ts` | The L2 leg: `claimViaHub` (register-if-first, decided at claim time by `token_for`, race-tolerant), `exitViaHub` / `preflightHubExit` / `hubExitsPaused` (fail-closed) for L2→L1. |
| `flows.ts` / `l1-receipt.ts` / `l1-to-l2-readiness.ts` | `consumeWithdrawal` + `isOutboxMessageConsumed` for exits, the resilient receipt wait, and when an L1→L2 message becomes consumable. |
| `hub-token.ts` / `portal-address.ts` | The L2 token the hub derives for an ERC-20 (aztec-standards `Token`, `deployer = hub`, `salt = erc20`) and the portal clone the factory derives (salt = token). Both pinned against the on-chain derivations. |
| `register-hash.ts` / `claim-secret.ts` / `content-hash.ts` | The three-toolchain keystones (Solidity ↔ Noir ↔ TS): the factory's `register` message, the recipient-committed private-claim secret, the deposit/withdraw content hashes. |
| `factory-abi.ts` / `factory-registry.ts` / `erc20.ts` | Hand-written ABIs pinned against the forge artifacts; the factory's frozen registration; gas-capped ERC-20 metadata reads decoded from the factory's own bytes. |
| `manifest-v2.ts` | Strict schema for the generation manifest; every derivable address is re-derived on parse. Exported through `./sandbox`. |
| `journal.ts` / `backup.ts` / `recovery-crypto.ts` / `seal-trust.ts` | The in-flight journal, the sealed backup file, AES-GCM/PBKDF2 from `@nulo-sh/wallet-crypto`, the per-wallet seal-determinism cache. |
| `relay-claim.ts` / `status.ts` / `progress.ts` / `wallet-chain-id.ts` / `artifacts.ts` | Relayer-claim primitives, status and progress helpers, `walletChainIdOf`, the hub artifact. |

## Scripts

| Script | What |
|---|---|
| `bun run test` | vitest on Bun: pure functions, mocked-L1 orchestrations, the deploy journal, the harness's units. |
| `bun run typecheck` | `tsc --noEmit -p tsconfig.scripts.json` (src + scripts + test). |
| `bun run test:integration` | Boots one anvil + `aztec start --local-network`, deploys a generation, and drives each round trip as its own test on a fresh actor: public, private and relayed deposits; public and private exits; both pause switches; the Outbox round trip; registration races and a tampered registration. `SANDBOX_L1_RPC` + `SANDBOX_NODE_URL` attach to a network kept up by `sandbox:up`; `PP_SANDBOX_ARTIFACTS` keeps the run's artifacts. |
| `bun run sandbox:up --artifacts <dir>` | Boot and deploy, write `<dir>/{manifest,handle}.json`, then hold until SIGTERM. |
| `bun run sandbox:smoke` | Boot, deploy, run every flow once on one actor with timings, tear down. `deploy:sandbox [--smoke] [--keep]` is the same entry; `--keep` leaves the network up and prints how to re-attach. |

Every harness run reads the forge build (`contracts/bridge/evm/out/`, gitignored): in a fresh clone,
install the libs and `forge build` first ([`contracts/bridge/evm/README.md`](../../contracts/bridge/evm/README.md)).

## The local network

`scripts/sandbox/local-network.ts` owns its run: ports claimed from `~/.agents/ports.md`, each child
in its own process group, teardown by group. The node takes its store from `DATA_DIRECTORY` and its
temp stores from `TMPDIR`, both under `~/.cache/pp/bridge-sandbox/<run>/`, which teardown removes;
`aztec start --local-network` ignores `--data-directory`. Logs stay in `~/.cache/pp/bridge-sandbox/logs/`.

Fees: every harness transaction is paid by the local network's SponsoredFPC.

Deposits go straight to the token's portal (`scripts/sandbox/deposit.ts`): create the portal if the
factory has none, `approve`, then `depositToAztecPublic` or `depositToAztecPrivate`. It is test
plumbing, not a user-facing deposit.

## Key invariants

- **Leaf indices come from the mined portal event, never a preflight simulate.** A concurrent deposit
  changes a simulated index. `readPortalDeposit` accepts exactly one `DepositToAztec*` log emitted at
  the portal's address, with every field matching the call, so a token's look-alike log cannot forge it.
- **Checks run before the irreversible L1 transaction.** A non-positive amount or a recipient that is
  zero or off the Grumpkin curve is refused before any write.
- **A claim is decided at claim time** (`hub-l2.ts`): `token_for == 0` ⇒ this claim also registers.
  If another claimant registers in between, the registration path fails on the consumed register leaf
  and the claim is retried as a plain one; a deposit is never stranded on a race.
- **A private claim is recipient-committed.** A private deposit's stored value is a per-deposit
  `claim_salt`; `claim_private` re-derives the consumption secret from `(claim_salt, recipient)`
  in-circuit (`deriveTokenClaimSecret` ↔ the Noir `claim_secret` lib, keystone-pinned), so a leaked
  salt only lets someone claim to the bound recipient. The salt must be full-entropy random
  (`Fr.random()`): the secret hash is public on L1 and the amount is public, so a weak salt lets an
  observer brute-force the recipient. The public path uses a raw secret (`claim_public` binds the
  recipient in its content hash).
- **Tests run under vitest, not `bun:test`.** `@aztec-labs/foundation` calls `expect.addEqualityTesters`
  at import, which `bun:test`'s `expect` lacks.
- **Scripts spawn other programs only through `scripts/run.ts`**: argv arrays, never a shell string.
- **The deploy journal is the resume record.** Every irreversible generation step is appended after its
  receipt, stamped with the chain, rollup and deployer; a re-run skips journalled steps and adopts a
  factory or hub that landed before its line was written only when its bindings agree.
