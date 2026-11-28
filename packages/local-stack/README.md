# @pp/local-stack

One command brings up everything the bridge and the pool need on one machine:

```bash
bun run demo:prepare  # once per worktree (networked): the pool's checkout and the bridge contracts
bun run demo          # boot (about 97 s), print how to reach it, tear down
bun run demo --keep   # boot and hold until SIGINT, SIGTERM or SIGHUP
bun run demo:smoke    # with the kept stack's PP_STACK_MANIFEST: bridge, claim, ragequit and settle once
```

It starts one anvil (chain 31337) and the Aztec 6.0.0 local network on it through bridge-core's
sandbox harness. Then pp-env deploys the pool on that same anvil: the Poseidon libraries, the pool
contracts, a 6-decimal test token and the mock ASP. The `bridge` step deploys one bridge generation
for that token with entries paused (bridge-core's `@pp/bridge-core/deploy`), reads every binding
back, checks that the hub is the v1 class and only then opens entries. The `seed` step registers
the demo's pool user and gives it two approved notes of 100. The `bot` step starts `@pp/asp-bot` as
`<runId>-bot` on the bridge's ASP registry, whose poster and intake it derives from the run id, and
approves the births of the bridge's labelled token. It finishes only once the first post has
landed, and the manifest's `bot` block names its snapshot URL.

Besides the toolchain (Bun, Foundry 1.7.1, Aztec 6.0.0), a fresh worktree needs one networked step:
`bun run demo:prepare`. It fetches the pool's checkout (about 1.5 min on a CI runner) and installs
and builds the bridge contracts the `bridge` step deploys. Every boot after that is offline, and a
boot that finds either missing fails in under a second naming that command. Set `FORGE` to point
it at CI's Foundry 1.7.1 when the one on your `PATH` is newer.

A boot takes about 97 s on a 192-core host: network 37 s, pool 5 s, bridge 40 s, seed 12 s, then
the manifest and the first beat. Every local-stack CI job installs Foundry and builds the bridge
contracts (`.github/actions/bridge-evm-build`) before its suite.

## Output and exit codes

```
[stack] run stack-<pid>-<id> pid <pid>
[stack] network up in … s
[stack] pool starting on http://127.0.0.1:…
[stack] pool up in … s
[stack] bridge up in … s
[stack] seed up in … s
[stack] bot up in … s
[stack] manifest up in … s
[stack] heartbeat up in … s
[stack] circuits <pp-env's checkout>/packages/circuits/build
[stack] ready in … s — PP_STACK_MANIFEST=~/.cache/pp/runs/<runId>/manifest.json
[stack] pool user 0x… (two approved notes of 100); bridge sender 0x…
SANDBOX_L1_RPC=http://127.0.0.1:… SANDBOX_NODE_URL=http://127.0.0.1:…
```

| Code | When |
|---|---|
| 0 | a run without `--keep` booted and tore down cleanly |
| 130 | a signal stopped it (the boot unwinds once its current step returns) |
| 2 | an unknown argument, or `SANDBOX_L1_RPC` / `SANDBOX_NODE_URL` set |
| 1 | the boot or the teardown failed (after tearing down what had started) |

## The manifest

`PP_STACK_MANIFEST` names a `StackManifest` (`@pp/bridge-core`, `parseStackManifest`). It is
written atomically, only once the stack is ready, and removed first on teardown. It is the one
source of truth for consumers; the printed `SANDBOX_*` pair exists for scaffold-harness suites,
which attach through it. The stack refuses to boot while either variable is non-empty, because
scaffold's harness would attach to the chain they name and the pool would be deployed onto it.

Attaching is not proof of life. A manifest can outlive a stack that was killed, so before trusting
one, check that the L1 RPC reports chain 31337 and that the manifest's addresses have code. That
proves a compatible chain, not the same stack: a later one on reused ports deploys the same
deterministic addresses. The run directory's `pid` file names the process that wrote it; a dead pid
marks a crashed stack, a live one may be recycled.

## Teardown

Teardown is exact and ordered: heartbeat, manifest, bot, the bridge deployer's PXE, pool, network,
run directory. Every step is attempted, and failures are reported together. Only the process
groups, ports (from the shared registry) and directories this run created are touched. A process that exits without teardown
(an uncaught error) still runs the network harness's exit hook, which kills the network's groups
and removes its directories; SIGKILL skips it, and those groups outlive the process.

A run id owns its run directory, which is created exclusively, so a second stack with the same id
is refused. No run id may end in `-pool` or `-bot`: every harness releases registry rows by owner
id, and the pool and the bot run as `<runId>-pool` and `<runId>-bot`. A run id chosen by the
caller must be unique on the host while its stack runs: the exclusive claim covers one `runsDir`, and a stack under another one with the same
id would share the harnesses' registry rows and data directory.

## Clocks: think in blocks, not minutes

Measured on this stack:

- Ethereum time is **+12 s per block** whatever the wall time: Aztec's L1 deploy sets anvil's block
  timestamp interval to its Ethereum slot.
- An Aztec block **jumps to the next 72 s slot** boundary, and its propose block carries that
  timestamp.
- **Idle time does not exist.** With no transactions, neither chain moves.
- So the pool's 1200 s keystore-root liveness is 100 Ethereum blocks or about **17 Aztec blocks**,
  and an 1800 s window is about **25 Aztec blocks**.
- An L1→L2 message is consumable from the first Aztec block built **after the node has read it**
  from Ethereum. A block built before that (one racing the message) misses it, and the **next**
  block carries it.
- An Aztec block is finalized once the **next** Aztec block exists.

These depths are measured on Aztec 6.0.0's local network, not specified by it; the heartbeat
tests fail if a toolchain bump changes them. An L2→L1 message reaching the Outbox through beats
alone is not verified here: sending one needs an Aztec account and contract, so the bridge's exit
tests carry that proof.

## Heartbeat

The heartbeat mines an Aztec block (`aztecDebug_mineBlock`) only for work that waits on one. It
checks every 2 s (`startStack`'s `heartbeatMs`); a tick that owes nothing mines nothing, so the
tick never ages the chain. It owes:

- **two beats** after any Ethereum transaction other than the node's own propose, or a revert
  of the block it last scanned (so an L1→L2 message is carried even when the first beat races the
  node's read of it);
- **one beat** after any Aztec block it did not mine, or one of its own that picked up a pending
  user transaction (so that block finalizes).

An owed beat waits until the newest block is proven: the node proves everything checkpointed in
one L1 block, so a block proven together with its follow-up would not be finalized by it. The node
proves within seconds on its own; a node that stops proving stalls every owed beat, L1→L2
inclusion included, without an error.

The node's propose is matched by sender and target together, learned from the first beat, which is
part of readiness: a node without the debug method fails the boot. A tick that finds a beat still
open is skipped, and a beat open past 180 s is logged.

Cost: every user action costs about two Aztec blocks (144 s of chain time). A session of a dozen
actions crosses an 1800 s window, so anything stamped by chain time (the bot's registry record)
depends on being re-posted.

## Accounts

Anvil account 0 is the node's publisher; bridge actors start at 1; pp-env uses 13 (user) and 14
(deployer); bridge-core's harness uses 15, which owns the stack's bridge. The demo's pool user is
13 (registered, two approved notes of 100) and its separate Ethereum sender is 12: a bridge sent
from the note owner's own address is refused. The probe suite also uses 10 to 12.

## Tests

```bash
bun run --cwd packages/local-stack test                    # unit
bun run --cwd packages/local-stack test:integration        # boots real stacks; the pull-request gate
bun run --cwd packages/local-stack test:integration:long   # 32 min of idling at the default tick; nightly
```

All run under vitest, never `bun test`: on a cold transpiler cache, as on every fresh CI runner,
`bun test` injects its `expect` into `@aztec-labs/foundation`, which then throws at import
(`expect.addEqualityTesters is not a function`). A warm cache hides it, so reproduce with
`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`.
