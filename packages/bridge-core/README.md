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
| `@pp/bridge-core` | `src/index.ts`: the bridge client (`openBridgeSession`, `prepareBridgeSpend`, `createBridgeClient`), hub reads, readiness, hashes, secrets. |
| `@pp/bridge-core/artifacts` | The committed hub and labelled-token artifacts. |
| `@pp/bridge-core/sandbox` | `scripts/sandbox/`: boot a local network, deploy a generation, read its bindings back. Also the generation manifest schema (`manifest-v2`), a per-run handoff. Node only. |

## File map (`src/`)

| File | Purpose |
|---|---|
| `client/` | The bridge client: the session and its keys, the sealed journal, the spend checks, `submit` and its resolver, claims, `records` and `recover`, and exits (`ragequitPayload`, `exitTickets`, `exitStatus`, `settle`). `createBridgeClient` wires them over the manifest's RPC and node and checks the deployment once. |
| `hub-l2.ts` | Reads of the L2 hub: `hubAt`, and an ERC-20's token binding through `token_for` or straight from public storage (`hubBindingAt`). |
| `l1-receipt.ts` / `l1-to-l2-readiness.ts` | The resilient receipt wait, and when an L1→L2 message becomes consumable. |
| `hub-token.ts` / `portal-address.ts` | The L2 token the hub derives for an ERC-20 (`LabelledToken`, `deployer = hub`, `salt = erc20`, the hub's ASP registry among its constructor arguments) and the portal clone the factory derives (salt = token). Both pinned against the on-chain derivations. |
| `register-hash.ts` / `claim-secret.ts` | The keystones: the factory's `register` message (Solidity ↔ Noir ↔ TS) and the recipient-committed private-claim secret (Noir ↔ TS, re-exported from `@pp/bridge-spec/claim-secret`). |
| `factory-abi.ts` / `factory-registry.ts` / `erc20.ts` | Hand-written ABIs pinned against the forge artifacts; the factory's frozen registration; gas-capped ERC-20 metadata reads decoded from the factory's own bytes. |
| `manifest-v2.ts` | Strict schema for the generation manifest; every derivable address is re-derived on parse. Exported through `./sandbox`. |
| `wallet-chain-id.ts` / `artifacts.ts` | `walletChainIdOf`, the hub and labelled-token artifacts. |

## Scripts

| Script | What |
|---|---|
| `bun run test` | vitest on Bun: pure functions, mocked-L1 orchestrations, the deploy journal, the harness's units. |
| `bun run typecheck` | `tsc --noEmit -p tsconfig.scripts.json` (src + scripts + test). |
| `bun run test:integration` | Boots one anvil + `aztec start --local-network`, deploys a generation, and checks its bindings: vault, cap, paused entries, one portal per manifest token. `SANDBOX_L1_RPC` + `SANDBOX_NODE_URL` attach to a network kept up by `sandbox:up`; `PP_SANDBOX_ARTIFACTS` keeps the run's artifacts. |
| `bun run test:hub` | Boots a local network of its own and runs the hub on it, block by block: `register_token` and its publish, a claim from a pool withdrawal, a ragequit and a public exit after an unshield, each consumed on the real Outbox, and each refused ragequit and public exit. Two anvil accounts stand in for the factory and the portal, so it needs no vault and no factory deploy. |
| `bun run test:integration:stack [vitest args]` | The stack suite (`test/integration/stack/`): deploy, bridge, submit, re-proof, journal, the first path, exits, births (a shielded note's birth label through the bot's approval to a checked transfer) and the ragequit CLI, against a stack with its bot: the one `PP_STACK_MANIFEST` names or one `scripts/with-stack.ts` boots and stops. CI runs it and the smoke under one stack and requires every id of `scripts/check-cases.ts`'s `bridge` group. |
| `bun run demo:smoke` (root) | On the local stack `PP_STACK_MANIFEST` names: seeds a pool account, bridges 70, claims it with the account's deployment, ragequits it and settles to a fresh payee, printing each step's time. |
| `bun run sandbox:up --artifacts <dir>` | Boot and deploy, write `<dir>/{manifest,handle}.json`, then hold until SIGTERM. |
| `bun run sandbox:smoke` | Boot, deploy, run every flow once with timings, tear down. `deploy:sandbox [--smoke] [--keep]` is the same entry; `--keep` leaves the network up and prints how to re-attach. |
| `bun run ragequit` (root) | On the local stack `PP_STACK_MANIFEST` names: burns a label's balance in exact chunks (`--amount`, `--label`, `--payee`), each paid by the SponsoredFPC, waits for each ticket's Outbox root and settles it. `--settle-only --payee <a>` settles that payee's tickets from chain data with `PP_L1_KEY` alone. Refuses a manifest, an L1 RPC or a node on any chain but 31337 before reading `PP_AZTEC_SECRET` or `PP_L1_KEY`, checks both keys' range, keeps the secret's wallet store in a tmpfs `/dev/shm` (refusing to burn without one), and never prints them. Each burn must show its ticket before the settles start. |

Every harness run reads the forge build (`contracts/bridge/evm/out/`, gitignored): in a fresh clone,
install the libs and `forge build` first ([`contracts/bridge/evm/README.md`](../../contracts/bridge/evm/README.md)).

## The bridge client

Before its first action, `createBridgeClient` checks that the L1 RPC and the Aztec node are on the
manifest's chain. It also checks that the portal is the factory's clone for the pool's asset, bound
to the manifest's hub and vault and to the rollup the node follows; that the hub binds the asset to
the manifest's token; and that the portal was created at or after the manifest's scan start. Reads
are trusted beyond that.

Fees: every L2 transaction the client builds pays through the SponsoredFPC: the claim, and with it
the recipient's account deployment, which the wallet sends in the same transaction (`preflight`
only simulates the sponsored path), each ragequit burn and each public exit. No option takes a fee
or a payment method, so the holder's own Fee Juice never pays: the fee payer is public, and paying
from the account would link it to its bridge or to its exit ticket. This holds only where a
sponsored FPC exists, which today means the local network and the testnet.

Exits: `exitTickets` reads the hub's `RagequitTicket` and `PublicExitTicket` events for the
manifest's token and matches each to its own Outbox message, so identical exits in one transaction
settle separately. `exitStatus` and `settle` key a ticket by its witness's `(epoch, leafId)`, never
by content. `ragequitPayload` and `exitPublicPayload` build the hub's `ragequit` and `exit_public`
for the holder's wallet to send, from the request as it was at the call, and refuse a payee whose
checksum fails or whom the portal would never pay before building.

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
