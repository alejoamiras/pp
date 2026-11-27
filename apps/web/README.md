# @pp/web

The web app for the label bridge. It shows a pool balance by label, bridges part of a pool note to
Aztec under the same label, connects an Aztec wallet through the wallet SDK, waits for the bridge and
claims it, lists private balances by label with their allow-list state, and sends privately,
unshields, shields, leaves to Ethereum (ragequit), withdraws the public balance and collects exits on
Ethereum.

Every screen runs on an in-memory fixture world behind the data ports in `src/data/ports.ts`. The
fixture world keeps chain time (it moves only with blocks) and is driven from tests and the browser
console through `window.__ppFixtures`, which fixture builds expose and stack builds cannot contain.

A stack build (`build:local` with `PP_STACK_MANIFEST` from `bun run demo --keep`) reads the local
stack instead through `src/data/adapters/`: Ethereum through the injected wallet, chain time from
both chains, and the pool notes by label through pool-client, with one worker prover per page. Its
bridge part, the Aztec balances, exits and the allow list are not wired yet: the pool view lists the
notes and says why bridging is closed. It is served by `serve`, which also serves the pinned
proving files from `PP_CIRCUITS_DIR`, the pool checkout's circuit builds that the stack's CLI
prints; they are never part of a build. `serve` refuses to start unless that is an absolute
directory.

## Scripts

Run from the repository root with `bun run --cwd apps/web <script>`.

| Script | What it does |
|---|---|
| `dev` | Vite dev server on fixtures and the fixture wallet, on a port claimed from the host registry |
| `build` | Production build on fixtures and the fixture wallet, plus `dist/security-headers.json` |
| `build:local` | The build the e2e kit runs, with the real wallet connector: against a stack manifest (`PP_STACK_MANIFEST`), or fixtures from a sandbox run's artifacts (`PP_SANDBOX_ARTIFACTS`) |
| `check:stack-build` | Builds against a synthetic stack manifest and fails on any fixture or build-only module, or a bot account, in the output |
| `preview` | Serves a fixture build with its security headers |
| `serve` | Serves a build with its security headers and the pinned proving files at `/<cid>`, read from `PP_CIRCUITS_DIR` |
| `typecheck` | `tsc --noEmit` |
| `test` | Unit and component tests (Vitest on Bun, jsdom for components) |
| `test:headers` | Checks both servers' headers the way the e2e kit starts them |
| `e2e` | Runs the e2e kit in stack mode: the local stack, the test wallet and Playwright against `build:local` |

## Recovery

A holder can always leave from a device restored from the account's keys alone, with one exception: balance notes tagged under an interactive handshake that the holder's wallet signed for that note's (sender, holder) pair stay hidden until the wallet imports that handshake's ephemeral key (`eph_pk.x`). A wallet that signs interactive handshakes must back up each key. A wallet that cannot sign one, such as the embedded test wallet, is not affected.
