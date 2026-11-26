# @pp/local-stack

One command brings up everything the bridge and the pool need on one machine:

```bash
bun run demo          # boot, print how to reach it, tear down
bun run demo --keep   # boot and hold until SIGINT, SIGTERM or SIGHUP
```

It starts one anvil (chain 31337) and the Aztec 6.0.0 local network on it through bridge-core's
sandbox harness. Then pp-env deploys the pool on that same anvil: the Poseidon libraries, the pool
contracts, a 6-decimal test token and the mock ASP.

## Output and exit codes

```
[stack] run stack-<pid>-<id> pid <pid>
[stack] network up in … s
[stack] pool starting on http://127.0.0.1:…
[stack] pool up in … s
[stack] manifest up in … s
[stack] heartbeat up in … s
[stack] ready in … s — PP_STACK_MANIFEST=~/.cache/pp/runs/<runId>/manifest.json
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

Teardown is exact and ordered: heartbeat, manifest, pool, network, run directory. Every step is
attempted, and failures are reported together. Only the process groups, ports (from the shared
registry) and directories this run created are touched. SIGKILL skips teardown; the harnesses'
last-resort exit hooks still reap what they can.

A run id owns its run directory, which is created exclusively, so a second stack with the same id
is refused. No run id may end in `-pool`: both harnesses release registry rows by owner id, and
the pool runs as `<runId>-pool`.

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

The heartbeat mines an Aztec block (`aztecDebug_mineBlock`) only for work that waits on one. On a
120 s tick it owes:

- **two beats** after any Ethereum transaction other than the node's own propose, or a revert
  of the block it last scanned (so an L1→L2 message is carried even when the first beat races the
  node's read of it);
- **one beat** after any Aztec block it did not mine, or one of its own that picked up a pending
  user transaction (so that block finalizes).

The node's propose is matched by sender and target together, learned from the first beat, which is
part of readiness: a node without the debug method fails the boot. A tick that finds a beat still
open is skipped, and a beat open past 180 s is logged.

Cost: every user action costs about two Aztec blocks (144 s of chain time). A session of a dozen
actions crosses an 1800 s window, so anything stamped by chain time (the bot's registry record)
depends on being re-posted.

## Accounts

Anvil account 0 is the node's publisher; bridge actors start at 1; pp-env uses 13 (user) and 14
(deployer); bridge-core's harness uses 15. The probe suite also uses 10 to 12.

## Tests

```bash
bun run --cwd packages/local-stack test                 # unit
bun run --cwd packages/local-stack test:integration     # boots real stacks
```

Both run under vitest, never `bun test`: on a cold transpiler cache, as on every fresh CI runner,
`bun test` injects its `expect` into `@aztec-labs/foundation`, which then throws at import
(`expect.addEqualityTesters is not a function`). A warm cache hides it, so reproduce with
`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`.
