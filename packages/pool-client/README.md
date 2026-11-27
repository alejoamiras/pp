# @pp/pool-client

A Privacy Pools v2 client for Node, Bun and the browser, over `@0xbow/privacy-pools-v2-sdk` 1.0.2.
It opens a client from a wallet signature, lists the user's notes with their label status, prepares and checks a one-input
`transact_1x1` spend to a processor contract with caller `data`, and recovers the change note's opening from chain data. It
never submits a transaction, registers a keystore or makes a deposit.

## Use

```ts
import { openPoolClient, secretDerivationTypedData } from "@pp/pool-client"

const signature = await wallet.signTypedData(secretDerivationTypedData(address))
const client = await openPoolClient({ pool, l1Address: address, signature, artifacts: { kind: "gateway", urls: [gateway] } })

const [note] = (await client.notes()).filter((n) => n.status === "approved")
const spend = await client.prepareSpend({ note: note.commitment, amount: 70n, processor, data })
await client.assertFresh(spend)          // the proof's roots still pass at one pinned block
// send `spend.proof`, `{ processor: spend.processor, data: spend.data }` and `spend.noteData` unchanged:
// the proof's context binds them
```

**The signature is a private key.** It derives every pool key of the user, and the bridge's claim key too. Keep it in memory;
never log, store or send it. The client keeps it in a closure, and its errors never carry it.

## What a prepared spend guarantees

`prepareSpend` returns a deep-frozen spend only after these checks pass, in order: its shape; the request as captured before the
first await; the transact params; the public signals; the nullifier, re-derived from the signature; the change, decrypted
from `noteData` and matched against the proof's output, label and value; the context hash. `assertRecoverable(spend)`
re-runs them on a spend held elsewhere, against that spend's own processor, `data` and amount and the note this client
owns: it proves the spend consistent and its change recoverable, not that it matches the request it was made for. A failed
check throws `PoolClientError` with code `SPEND_CHECK_FAILED` and the check's name. `spendRevertCode(revertData)` maps the vault's three stale-root reverts to the codes `assertFresh` uses.

Choosing a trusted processor is the caller's job: the proof binds the processor and `data`, not what the processor does.

## Circuit files

Files are checked against the SDK's pinned manifest in every runtime: sha256 and size, with a gateway response cut off at the
file's pinned size. In a browser they are kept in Cache Storage across page loads; a cached entry that fails its digest is
dropped and fetched again. `{ kind: "dir", path }` reads a local build instead.

Proving runs on the calling thread unless `openPoolClient` gets `prover: workerProver(worker)`, where the worker's module
imports `@pp/pool-client/prover-worker`. The worker keeps a page responsive; `terminate()` rejects every pending call.

| Where | `transact_1x1` prove | `prepareSpend` |
|---|---|---|
| Node | 1.4–2.0 s | |
| Bun (single-thread curve) | 9.5–10.8 s | |
| Chromium, main thread | 2–5 s, with main-thread stalls up to about 370 ms | 5.1 s |
| Chromium, worker | 2–4 s, longest main-thread stall under 50 ms | 2.8–5.4 s |

## Tests

| Script | Needs | What |
|---|---|---|
| `test`, `test:node` | nothing | unit, under Bun and Node |
| `test:proof`, `test:proof:node` | pp-env's fetched checkout | real Groth16 on the pinned files, no chain |
| `test:integration`, `test:integration:node` | the checkout, Aztec 6.0.0's anvil | seven steps against `pp-env up` |
| `test:browser` | the checkout, Playwright's Chromium | prove, cache and worker in Chromium, cross-origin isolated |
| `test:browser:integration` | all of the above | a spend prepared in the page that the vault accepts |

`@pp/pool-client/testing` (Node and Bun only) exports the seeder those suites use: users, keystore registration, deposits,
label approval and stub processors on a running `pp-env up`; `circuitsDir()` is the fetched pinned circuits, for
`{ kind: "dir", path: circuitsDir() }`. It is test support, not part of the client. CI runs the suites that need the
checkout inside a network namespace with loopback only (`scripts/offline-gate.sh`).

## Licence

Apache-2.0. A bundle that includes the prover also includes snarkjs and circomlibjs, so it is distributed under GPL-3.0 terms.
