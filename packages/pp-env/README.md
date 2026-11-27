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

- `deployPoolOn` runs the same `DeployE2ELocal` forge path as the local env, without cheat codes, so the canonical Poseidon libraries must already hold their published code. It then grants `postman` the postman role, deploys, enables and mints the test token, and runs `verifyPoolCode`.
- `verifyPoolCode` compares the runtime code with the fetched build, at one block, for every proxy and its implementation, the relay, the access router, all 27 verifiers and every linked library, and the test token with pp-env's build. Immutables are masked in that comparison, then each is read through its getter and must hold the access router, vault or entrypoint passed in, the canonical ERC-5564 announcer, or the implementation's own address. Each transact route must call its verifier's own `verifyProof` selector.
- `startMockAsp` approves only `owner`'s deposits. It decrypts each deposit's ASP ciphertext and accepts the label only if it rebuilds the commitment the vault inserted, then posts the set's root. It serves `GET` read routes only (root, leaves, public key, event snapshot); `/admin/*` answers 404. Its X25519 key derives from the postman key, so a restart rebuilds the same set from the chain without stored state. It is Bun only.
- `sepoliaPoolUser` builds a pool user from an L1 key, with the checkout's circuits, so a caller on another viem copy passes only plain data.

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
