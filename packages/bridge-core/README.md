# @pp/bridge-core

Framework-agnostic L1↔L2 bridge logic in TypeScript over `viem` (L1) and `aztec.js` (L2), plus the
local-network harness that proves it. No UI framework, no server.

One **generation** per network: an L1 `PortalFactory` (one processor-portal clone per ERC-20, all
bound to one Privacy Pools vault and lifetime cap) and one L2 `TokenBridgeHub` that registers a token from the factory's attested words and derives its L2
`LabelledToken`. Every derivable address (portal, hub, L2 token) is a pure function of that pair, and this
package re-derives it rather than trusting a file.

## Entry points

| Import | What |
|---|---|
| `@pp/bridge-core` | `src/index.ts`: the bridge client (`openBridgeSession`, `prepareBridgeSpend`, `createBridgeClient`), hub reads, exit consumption on L1, readiness, hashes, secrets, journal. |
| `@pp/bridge-core/artifacts` | The committed hub and labelled-token artifacts. |
| `@pp/bridge-core/sandbox` | `scripts/sandbox/`: boot a local network, deploy a generation, read its bindings back. Also the generation manifest schema (`manifest-v2`), a per-run handoff. Node only. |

## File map (`src/`)

| File | Purpose |
|---|---|
| `client/` | The bridge client: the session and its keys, the sealed journal, the spend checks, `submit` and its resolver, claims, `records` and `recover`. `createBridgeClient` wires them over the manifest's RPC and node and checks the deployment once. |
| `hub-l2.ts` | Reads of the L2 hub: `hubAt`, and an ERC-20's token binding through `token_for` or straight from public storage (`hubBindingAt`). |
| `flows.ts` / `l1-receipt.ts` / `l1-to-l2-readiness.ts` | `consumeWithdrawal` (the pre-v1 portal's `withdraw`; v1 portals settle with `settleRagequit` and `settlePublicExit`) + `isOutboxMessageConsumed` for exits, the resilient receipt wait, and when an L1→L2 message becomes consumable. |
| `hub-token.ts` / `portal-address.ts` | The L2 token the hub derives for an ERC-20 (`LabelledToken`, `deployer = hub`, `salt = erc20`, the hub's ASP registry among its constructor arguments) and the portal clone the factory derives (salt = token). Both pinned against the on-chain derivations. |
| `register-hash.ts` / `claim-secret.ts` / `content-hash.ts` | The three-toolchain keystones (Solidity ↔ Noir ↔ TS): the factory's `register` message, the recipient-committed private-claim secret (re-exported from `@pp/bridge-spec/claim-secret`), the deposit/withdraw content hashes. |
| `factory-abi.ts` / `factory-registry.ts` / `erc20.ts` | Hand-written ABIs pinned against the forge artifacts; the factory's frozen registration; gas-capped ERC-20 metadata reads decoded from the factory's own bytes. |
| `manifest-v2.ts` | Strict schema for the generation manifest; every derivable address is re-derived on parse. Exported through `./sandbox`. |
| `journal.ts` / `backup.ts` / `recovery-crypto.ts` / `seal-trust.ts` | The in-flight journal, the sealed backup file, AES-GCM/PBKDF2 from `@nulo-sh/wallet-crypto`, the per-wallet seal-determinism cache. |
| `status.ts` / `progress.ts` / `wallet-chain-id.ts` / `artifacts.ts` | Status and progress helpers, `walletChainIdOf`, the hub and labelled-token artifacts. |

## Scripts

| Script | What |
|---|---|
| `bun run test` | vitest on Bun: pure functions, mocked-L1 orchestrations, the deploy journal, the harness's units. |
| `bun run typecheck` | `tsc --noEmit -p tsconfig.scripts.json` (src + scripts + test). |
| `bun run test:integration` | Boots one anvil + `aztec start --local-network`, deploys a generation, and checks its bindings: vault, cap, paused entries, one portal per manifest token. `SANDBOX_L1_RPC` + `SANDBOX_NODE_URL` attach to a network kept up by `sandbox:up`; `PP_SANDBOX_ARTIFACTS` keeps the run's artifacts. |
| `bun run test:hub` | Boots a local network of its own and runs the hub on it, block by block: `register_token` and its publish, a claim from a pool withdrawal, a ragequit and a public exit after an unshield, each consumed on the real Outbox, and each refused ragequit and public exit. Two anvil accounts stand in for the factory and the portal, so it needs no vault and no factory deploy. |
| `bun run sandbox:up --artifacts <dir>` | Boot and deploy, write `<dir>/{manifest,handle}.json`, then hold until SIGTERM. |
| `bun run sandbox:smoke` | Boot, deploy, run every flow once with timings, tear down. `deploy:sandbox [--smoke] [--keep]` is the same entry; `--keep` leaves the network up and prints how to re-attach. |

Every harness run reads the forge build (`contracts/bridge/evm/out/`, gitignored): in a fresh clone,
install the libs and `forge build` first ([`contracts/bridge/evm/README.md`](../../contracts/bridge/evm/README.md)).

## The bridge client

Before its first action, `createBridgeClient` checks that the L1 RPC and the Aztec node are on the
manifest's chain. It also checks that the portal is the factory's clone for the pool's asset, bound
to the manifest's hub and vault and to the rollup the node follows. Reads are trusted beyond that.

Fees: every L2 transaction the client builds (a claim, and an account's deployment through
`preflight`) pays through the SponsoredFPC. No option takes a fee or a payment method, so the
holder's own Fee Juice never pays: the fee payer is public, and paying from the account would link
it to its bridge. This holds only where a sponsored FPC exists, which today means the local network
and the testnet.

## The local network

`scripts/sandbox/local-network.ts` owns its run: ports claimed from `~/.agents/ports.md`, each child
in its own process group, teardown by group. The node takes its store from `DATA_DIRECTORY` and its
temp stores from `TMPDIR`, both under `~/.cache/pp/bridge-sandbox/<run>/`, which teardown removes;
`aztec start --local-network` ignores `--data-directory`. Logs stay in `~/.cache/pp/bridge-sandbox/logs/`.

Fees: every harness transaction is paid by the local network's SponsoredFPC.

The sandbox has no Privacy Pools vault yet: the generation binds a placeholder address
(`SANDBOX_POOL`) and keeps entries paused, so no bridge round trip runs on it.

## Key invariants

- **Checks run before the irreversible L1 transaction.** A non-positive amount or a recipient that is
  zero or off the Grumpkin curve is refused before any write.
- **A claim is recipient-committed.** A bridged deposit's stored value is a per-deposit
  `claim_salt`; the hub re-derives the consumption secret from `(claim_salt, claiming account)`
  in-circuit (`deriveTokenClaimSecret` ↔ the Noir `claim_secret` lib, keystone-pinned), so a leaked
  salt lets no other account claim. The salt must be full-entropy random (`Fr.random()`): the secret
  hash is public on L1 and the amount is public, so a weak salt lets an observer brute-force the
  recipient.
- **Tests run under vitest, not `bun:test`.** `@aztec-labs/foundation` calls `expect.addEqualityTesters`
  at import, which `bun:test`'s `expect` lacks. A warm Bun transpiler cache hides the failure and every
  CI runner starts cold, so the root gate scripts set `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`.
- **Scripts spawn other programs only through `scripts/run.ts`**: argv arrays, never a shell string.
- **The deploy journal is the resume record.** Every irreversible generation step is appended after its
  receipt, stamped with the chain, rollup and deployer; a re-run skips journalled steps and adopts a
  factory or hub that landed before its line was written only when its bindings agree. A factory's
  bindings are its implementation and hub and the implementation's vault and cap, checked on a fresh
  deploy, an adopted landing and a journalled resume alike. A journal from before a hub or token
  class change is refused by its class-id check, so a sandbox kept across such a change cannot
  resume: boot a fresh one.
