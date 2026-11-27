# @pp/web

The web app for the label bridge. It shows a pool balance by label, bridges part of a pool note to
Aztec under the same label, connects an Aztec wallet through the wallet SDK, waits for the bridge and
claims it, lists private balances by label with their allow-list state, and sends privately,
unshields, shields, leaves to Ethereum (ragequit), withdraws to Ethereum from a label or from the
public balance, and collects exits on Ethereum.

Every screen runs on an in-memory fixture world behind the data ports in `src/data/ports.ts`. The
fixture world keeps chain time (it moves only with blocks) and is driven from tests and the browser
console through `window.__ppFixtures`, which fixture builds expose and stack builds cannot contain.

A stack build (`build:local` with `PP_STACK_MANIFEST` from `bun run demo --keep`) reads the local
stack instead through `src/data/adapters/`: Ethereum reads through the stack's RPC and its signatures
and sends through the injected wallet, chain time from both chains, the asset's decimals and symbol from the factory's registration, the pool notes by
label through pool-client with one worker prover per page, the bridge and its claim through
bridge-core's client, the Aztec balances by label, the public balance, the private send, the
unshield, the shield, the ragequit and both withdrawals to Ethereum through the connected wallet, and
the exit tickets, their status and their collection through bridge-core's client. The allow list is
the registry's record and its time read at one Aztec block, with each label checked against the bot's
snapshot of that record's roots in one Web Worker (see below). A private send, an unshield or a
withdrawal from a label checks its label again right before it is built and sends nothing for a
label the latest list does not hold. A withdrawal from a label is one transaction that unshields the
amount and withdraws it, so Ethereum sees the payee and the amount but not the label. These spends,
the shield and the public balance's withdrawal are paid by the SponsoredFPC. On the local stack
(chain 31337 over a loopback RPC) the build can also send a bridge and collect an exit from anvil's
dev account, so the demo needs no second wallet account. It is served by `serve`, which also serves
the three proving files of `transact_1x1`, the one circuit the app proves, from `PP_CIRCUITS_DIR`,
the pool checkout's circuit builds that the stack's CLI prints; they are never part of a build.
`serve` refuses to start unless that is an absolute directory.

Two rules hold in every build. A collect first shows the account it is sent from and the payee, and
says when that transaction links the two in public; it refuses the signed-in pool owner's address
unless the user accepts that link for it. An Aztec send whose outcome the page could not read, or
one the node dropped, holds its account's sends until a Refresh reads that transaction included or
reverted; one whose wallet call failed after it was handed over holds until the page reloads.

### Ethereum for a local demo by hand

The page signs in with the account that owns the pool notes, so a human needs an injected
Ethereum wallet holding the demo's pool user. It takes two minutes:

1. Boot the stack with `bun run demo --keep`. It prints `SANDBOX_L1_RPC=<url>`; the port changes
   from run to run.
2. In the wallet, add a network with that URL as its RPC and chain ID 31337.
3. Import anvil's account 13, the demo's pool user, which holds two approved notes of 100:
   `cast wallet private-key "test test test test test test test test test test test junk" 13`
   prints its key, and the account is `0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec`. It is one of
   anvil's public test keys: never send real funds to it.
4. Choose "Sign in with Ethereum". A bridge sent from the owner's own address is refused, so choose
   "Send from the local dev account": the bridge, and a collect on the Exits screen afterwards,
   then send from anvil's account 12 with no wallet prompt. A wallet switch or a sign-out ends that
   choice.

## The allow-list check

A snapshot is untrusted input from the bot, so it is parsed and hashed only in the worker, and only
as far as a check needs:

- The download is bounded by its bytes, counted as they arrive (the canonical largest list plus 1
  KiB; a Content-Length is never trusted), by 30 s of silence and by 300 s in all. Hashing has no
  deadline: one would refuse a legal list on a slow device.
- The snapshot's declared roots must be the record's before anything is hashed. A label not in its
  origin's list is "not found" with no tree built; a found label builds that origin's tree once,
  and every other label of the same list reuses it.
- Work is keyed by the roots, never the sequence, so the bot's heartbeat (the same roots under a new
  sequence) costs no download and no hash. A 404 reads the latest record and, when it keeps the
  roots, fetches its sequence once.
- A list that timed out, does not match the chain, is too large, or whose check was cancelled fails
  at once, with no work, until Check again, which waits 5 s, then twice as long each time, up to
  5 minutes. One check runs at a time; the page shows its progress and can cancel it, which ends
  the worker.

A testnet build (`build --mode testnet` with `PP_DEPLOYMENT`, a testnet deployment file, into
`dist-testnet/`) targets the own pool on Sepolia and the public Aztec testnet. Its ASP and bot are
the page's own `/asp` and `/bot`, which `serve --deployment` proxies to the file's loopback ports.
[`TESTNET.md`](TESTNET.md) is the runbook.

## Scripts

Run from the repository root with `bun run --cwd apps/web <script>`.

| Script | What it does |
|---|---|
| `dev` | Vite dev server on fixtures and the fixture wallet, on a port claimed from the host registry |
| `build` | Production build on fixtures and the fixture wallet, plus `dist/security-headers.json` |
| `build:local` | The build the e2e kit runs, with the real wallet connector: against a stack manifest (`PP_STACK_MANIFEST`), or fixtures from a sandbox run's artifacts (`PP_SANDBOX_ARTIFACTS`) |
| `check:stack-build` | Builds against a synthetic local and remote stack manifest, the testnet fixture file and fixtures; fails on any fixture or build-only module or bot account in a stack build, on an `expected` value in the testnet build or any origin beyond its node and L1 RPC, and unless the demo sender is in the local stack build alone, with no build holding its key |
| `preview` | Serves a fixture build with its security headers |
| `serve` | Serves a build with its security headers and the three `transact_1x1` proving files at `/<cid>`, read from `PP_CIRCUITS_DIR`; with `--deployment <file>`, a testnet build on 127.0.0.1 with `/asp` and `/bot` proxied |
| `typecheck` | `tsc --noEmit` |
| `test` | Unit and component tests (Vitest on Bun, jsdom for components) |
| `test:headers` | Checks both servers' headers the way the e2e kit starts them; `-- --target <file>` checks `serve --deployment` over that file's testnet build instead |
| `test:testnet-smoke` | `-- --target <file> [--no-upstreams]`: the testnet build in Chromium behind `serve --deployment`, reading the node and the L1 RPC from the page |
| `e2e` | Runs the e2e kit in stack mode: the local stack, the test wallet and Playwright against `build:local` |

## Recovery

A holder can always leave from a device restored from the account's keys alone, with one exception: balance notes tagged under an interactive handshake that the holder's wallet signed for that note's (sender, holder) pair stay hidden until the wallet imports that handshake's ephemeral key (`eph_pk.x`). A wallet that signs interactive handshakes must back up each key. A wallet that cannot sign one, such as the embedded test wallet, is not affected.
