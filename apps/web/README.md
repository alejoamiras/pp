# @pp/web

The web app for the label bridge. It shows a pool balance by label, bridges part of a pool note to
Aztec under the same label, connects an Aztec wallet through the wallet SDK, waits for the bridge and
claims it, lists private balances by label with their allow-list state, and sends privately,
unshields, shields, leaves to Ethereum (ragequit), withdraws the public balance and collects exits on
Ethereum.

Today every screen runs on an in-memory fixture world behind the data ports in `src/data/ports.ts`;
the stack adapters in `src/data/adapters/` refuse until their packages land. The fixture world keeps
chain time (it moves only with blocks) and is driven from tests and the browser console through
`window.__ppFixtures`, which fixture builds expose and stack builds cannot contain.

## Scripts

Run from the repository root with `bun run --cwd apps/web <script>`.

| Script | What it does |
|---|---|
| `dev` | Vite dev server on fixtures and the fixture wallet, on a port claimed from the host registry |
| `build` | Production build on fixtures and the fixture wallet, plus `dist/security-headers.json` |
| `build:local` | The build the e2e kit runs: fixtures with the real wallet connector, from a sandbox run's artifacts |
| `check:stack-build` | Builds against the stack adapters and fails on any fixture module in the output |
| `preview` | Serves a build with its security headers |
| `typecheck` | `tsc --noEmit` |
| `test` | Unit and component tests (Vitest on Bun, jsdom for components) |
| `test:headers` | Checks the preview server's headers the way the e2e kit starts it |
| `e2e` | Runs the e2e kit: a local network, the test wallet and Playwright against `build:local` |

## Recovery

A holder can always leave from a device restored from the account's keys alone, with one exception: balance notes tagged under an interactive handshake that the holder's wallet signed for that note's (sender, holder) pair stay hidden until the wallet imports that handshake's ephemeral key (`eph_pk.x`). A wallet that signs interactive handshakes must back up each key. A wallet that cannot sign one, such as the embedded test wallet, is not affected.
