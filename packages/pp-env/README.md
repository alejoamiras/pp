# @pp/pp-env

Privacy Pools v2 on a local anvil, for tests and local development. It fetches the pool at a pinned upstream commit, deploys it with the upstream Forge script, runs the upstream mock ASP, and gives typed helpers that prove and submit a spend bound to a processor contract.

The pool's code is fetched and verified, never vendored. Only anvil's well-known test keys are used.

## Use

```sh
bun run --cwd packages/pp-env fetch   # once, networked: fetch, verify, build (about 3.5 min cold)
bun run --cwd packages/pp-env up      # a local env; prints its addresses as JSON
```

```ts
import { startPoolEnv, USER_INDEX } from "@pp/pp-env"

const env = await startPoolEnv()                 // or { rpcUrl } to attach to a loopback anvil
const user = await env.createUser({ accountIndex: USER_INDEX })
const stub = await env.deployStub()
// deposit, approve the label with env.asp.approveLabel, sync, then:
const spend = await user.prepareSpend({ processor: stub, data: "0x", asset: env.asset, amountOut: 70n })
await env.submitViaStub(stub, spend, 12)
await env.stop()
```

`@pp/pp-env/client` holds the user-side helpers alone (key derivation from a wallet signature, the SDK wiring for registration, deposits and note discovery), with no dependency on the environment. Spends are proved and checked by `@pp/pool-client`. `ClientConfig.circuitBundle` names one of pool-client's pinned bundles (default `ceremony`); deposits read their circuit files through pool-client too, hashed against that bundle.

`@pp/pp-env/fork` serves a fork of a live chain that the caller owns. `attachForkPoolEnv` refuses any node but an anvil on 127.0.0.1 (not `localhost` or `[::1]`), on a port registered to the caller's `runId`, reporting the exact `clientVersion` and chain the caller names. It then starts a mock ASP that publishes as the registry's real postman through anvil impersonation, and returns a `ClientConfig` for `createPoolUser`. It starts no anvil and holds no key. Its `stop()` closes the ASP and releases only the `<runId>:pool` port row.

`@pp/pp-env/sepolia` deploys and serves a pool on chain 11155111, and refuses every other chain id, whether passed or served. It takes keys as values and holds no other key.

- `deployPoolOn` runs the same `DeployE2ELocal` forge path as the local env, without cheat codes, so the canonical Poseidon libraries must already hold their published code. The pool is built first with no key in forge's environment, and must not recompile; the caller's `checkBuild` then compares the artifacts with its pins, and only after it returns does the key reach forge's script. It then grants `postman` the postman role, deploys, enables and mints the test token, and runs `verifyPoolCode`. Its script takes each gas limit from the node's estimate (`--skip-simulation`), not forge's own replay, which prices the pool's `prague` and underprices Sepolia's later fork. The script talks to the chain through a loopback send relay (`src/send-relay.ts`, started by `src/env/relayed-script.ts`) that listens only while it runs: forge 1.7.1 under `--skip-simulation` re-sends a failed send without its gas limit, so the relay owns every re-send. On Sepolia the caller passes explicit fee caps, which reach forge as `--with-gas-price` and `--priority-gas-price`; forge's process group is ended after 10 minutes without a new receipt, and nothing restarts or resumes it.
- `verifyPoolCode` compares the runtime code with the fetched build, at one block, for every proxy and its implementation, the relay, the access router, all 27 verifiers and every linked library, and the test token with pp-env's build. Immutables are masked in that comparison, then each is read through its getter and must hold the access router, vault or entrypoint passed in, the canonical ERC-5564 announcer, or the implementation's own address. Each transact route must call its verifier's own `verifyProof` selector.
- `startMockAsp` approves only the deposits of `owners`, a non-empty list (an empty topic filter would match every depositor). It decrypts each deposit's ASP ciphertext and accepts the label only if it rebuilds the commitment the vault inserted, then posts the set's root. It serves `GET` read routes only (root, leaves, public key, event snapshot); `/admin/*` answers 404. Its X25519 key derives from the postman key, so a restart rebuilds the same set from the chain without stored state. It is Bun only.
- `sepoliaPoolUser` builds a pool user from an L1 key, with the checkout's circuits, so a caller on another viem copy passes only plain data.
- Every L1 send on Sepolia follows one set of rules, `@pp/pp-env/send-path`: `eth_sendRawTransaction` goes to the send endpoint (`sendRpcUrl`) and every other call to the read endpoint, both with redirects refused. The envelope is decoded first: a type other than 0, 1 or 2, another chain, an address the caller did not name, or a second transaction at a nonce this path already sent is refused before it leaves, the last naming the send it waits on. Only the received bytes go out. Success is an allow-list: the endpoint answered the hash computed here, or "already known" or "already imported" word for word, or a lookup answered HTTP 200 with that hash. A refusal (HTTP 429 or 503, a connection refused, or any code or message alloy's retry layer repeats) or an ambiguous answer (a timeout, a reset, HTTP 500, 502 or 504, an unreadable body) sends the same bytes again inside one 35 s budget, under forge's 45 s request timeout, the last attempt just before it ends. "nonce too low" and "replacement transaction underpriced" count as admitted only when a lookup finds the hash, and otherwise stop with the hash and nonce; so does a budget that ends with neither endpoint knowing it. Every other answer, however worded, passes through at once. An admitted hash the read endpoint does not show within 30 s is pushed again, until an answer other than an admission or a refusal. Each attempt and answer is a line in the caller's send log (`journalTo`, from the Node-only `@pp/pp-env/send-log`, so the send path's own entry needs no Node types), long hex cut to its length. Every wallet `@pp/pp-env/sepolia` builds is routed this way, and `sendThrough` wraps any viem transport, so a caller on another viem copy routes its own; it also never answers a sender's latest or pending count below one past its last admitted send.
- The send relay puts those rules in front of a client that cannot wrap its transport, from a loopback port claimed in the host registry, with a 4 MiB body cap and a 60 s idle timeout, so a request it holds for its budget keeps its connection. It also keeps the read side from looking older than what it served: a sender's latest or pending nonce is never answered below one past its last transaction with a served receipt (one naming that hash and a block), an `eth_estimateGas` error within 30 s of such a receipt is asked again and answered as it came if it persists, and a null receipt of a transaction it sent is asked again, since forge gives up on a receipt that reads null three times in a row once it has seen the transaction in a block. A read that is refused or answered ambiguously is asked again inside the request's budget. Whatever the relay gives up on answers -32000 with the endpoint's words in `data`, which neither alloy's nor viem's retries repeat. Forge runs in a watched process group that ends with the command however it dies.

How `prepareSpend` refuses:

- With no active note of the asset (or none with the given `input`): a plain `Error`, before `@pp/pool-client` is reached.
- With a malformed request (such as `data` that is not hex of whole bytes): a `TypeError`.
- Otherwise, pool-client's `PoolClientError` with its code:
  - `NOTE_NOT_FOUND` when pool-client's own discovery has not seen the note, or `NOTE_NOT_APPROVED` when it is not approved;
  - for a note that is found and approved, `AMOUNT_OUT_OF_RANGE` for an amount of zero or above the note, and `ARTIFACT_MISMATCH` for a circuit file that fails its pin.

A zero spend is always refused.

The `.`, `client` and `fork` entries load under Bun and under native Node with type stripping on by default (22.18+ or 23.6+), since the SDK resolves through `package.json#imports` (`#ppv2/*`) rather than tsconfig paths. Proving and `startPoolEnv` still call Bun's APIs, so they run under Bun only.

Everything after `fetch` runs offline. Each start re-verifies the fetched tree against its pins.

## Layout

- `src/env/fetch/`: the pinned fetch. It checks the tarball's sha256, verifies git-LFS objects against `CEREMONY.md`, runs a frozen pnpm install, and writes a manifest of every file a later step consumes.
- `src/env/`: anvil (started or attached), the deploy, the mock ASP, `startPoolEnv`, and the fork attach (`fork.ts`).
- `src/env/harness/`: anvil and the JSON-RPC readiness helpers. Ports, locks and process groups come from `@pp/run-isolation`.
- `src/sepolia/`: the Sepolia entry: deploy, code check, the mock ASP's read-only front, its approver and label recovery.
- `src/client/`: user-side helpers. `types/` holds the hand-written public types, which need no checkout.
- `contracts/`: the `StubProcessor` and `TestToken` fixtures. Run forge on them through `bun run forge:fixtures <build|test> …`.

## Tests

| Script | Needs the checkout | What |
|---|---|---|
| `test`, `typecheck` | no | unit tests; public types through the export map |
| `typecheck:full`, `test:smoke` | yes | the implementation against the SDK; proving under Bun; all three entries under native Node |
| `test:vitest` | yes | the client under vite's module runner, as a vitest consumer loads it |
| `test:contracts` | no (Forge) | fixture tests, fuzzed |
| `test:integration` | yes | parallel envs, attach, teardown; a full spend through the stub and the pool's rejections; spend refusals; the Sepolia entry on a chain-11155111 anvil (deploy, owner-only approval, restart, a tampered contract) |

CI (`.github/workflows/pp-env.yml`) fetches once through `.github/actions/ppv2-fetch`, then runs every post-fetch suite in a network namespace with loopback only.
