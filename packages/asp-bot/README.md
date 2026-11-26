# @pp/asp-bot

Posts the pool's ASP root to the ASP registry on Aztec and serves the snapshots that let a client
build a label path. Demo grade: snapshots live in memory, and a restart serves only what it posts next.

## What a tick does

1. Reads the registry's record and the Aztec tip, and selects one Ethereum block (`latest`, `safe` or
   `finalized`).
2. Reads `latestASPRoot()` at that block and the ASP's leaves, and refuses leaves that do not hash
   to that root.
3. Posts when the pool root or the birth root changed, or when 300 s of Aztec chain time passed since
   the last post. Before sending, it checks the registry's `post_root` assertions itself (sequence,
   non-zero root, monotonic block and time, observation lag ≤ 1800 s), so a refused post is a logged
   skip, not a failed transaction.

## Snapshots

| Route | Answer |
|---|---|
| `GET /v1/snapshots/latest` | The snapshot of the record the registry holds. |
| `GET /v1/snapshots/<sequence>` | That sequence, while held; else 404. |

Bodies are the `@pp/label-paths` wire format. Every answer is `cache-control: no-store` with no ETag,
because a sequence the bot no longer holds must never be served from a cache. Any method but `GET`
gets 405. `@pp/label-paths` recomputes both roots on parse, so the server cannot forge a path. It can
still leave a label out (see that package's README).

## Running it

`startBot(config)` starts the bot in its own process group and resolves once `/latest` serves. The
handle's `postNow()` asks for a post at once, and `stop()` stops the group, releases the bot's port
row and, with `removeDataOnStop`, deletes its wallet store. On the local network, the poster and
intake accounts derive from the stack's run id (`localBotAccounts`), so no key is configured.

## Tests

- Unit: `bun run --cwd packages/asp-bot test`.
- Against the local stack: `bun run --cwd packages/asp-bot test:integration` boots `bun run demo`,
  deploys a registry, approves two labels on the mock ASP and checks the first post end to end
  (about 10 minutes).
