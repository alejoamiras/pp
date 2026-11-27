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

`@pp/pp-env/client` holds the user-side helpers alone (key derivation from a wallet signature, the SDK wiring, spend proving), with no dependency on the environment.

Both entries load under Bun and under native Node with type stripping on by default (22.18+ or 23.6+), since the SDK resolves through `package.json#imports` (`#ppv2/*`) rather than tsconfig paths. Proving and `startPoolEnv` still call Bun's APIs, so they run under Bun only.

Everything after `fetch` runs offline. Each start re-verifies the fetched tree against its pins.

## Layout

- `src/env/fetch/`: the pinned fetch. It checks the tarball's sha256, verifies git-LFS objects against `CEREMONY.md`, runs a frozen pnpm install, and writes a manifest of every file a later step consumes.
- `src/env/`: anvil (started or attached), the deploy, the mock ASP, and `startPoolEnv`.
- `src/env/harness/`: process groups, the shared port registry, file locks.
- `src/client/`: user-side helpers. `types/` holds the hand-written public types, which need no checkout.
- `contracts/`: the `StubProcessor` and `TestToken` fixtures. Run forge on them through `bun run forge:fixtures <build|test> …`.

## Tests

| Script | Needs the checkout | What |
|---|---|---|
| `test`, `typecheck` | no | unit tests; public types through the export map |
| `typecheck:full`, `test:smoke` | yes | the implementation against the SDK; proving under Bun; both entries under native Node |
| `test:vitest` | yes | the client under vite's module runner, as a vitest consumer loads it |
| `test:contracts` | no (Forge) | fixture tests, fuzzed |
| `test:integration` | yes | parallel envs, attach, teardown; a full spend through the stub and the pool's rejections |

CI (`.github/workflows/pp-env.yml`) fetches once through `.github/actions/ppv2-fetch`, then runs every post-fetch suite in a network namespace with loopback only.
