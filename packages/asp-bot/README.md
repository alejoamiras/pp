# @pp/asp-bot

Posts the pool's ASP root to the ASP registry on Aztec and serves the snapshots that let a client
build a label path. Demo grade: snapshots live in memory, and a restart serves only what it posts next.

## What a tick does

1. Reads the registry's record and the Aztec tip, and selects one Ethereum block (`latest`, `safe` or
   `finalized`).
2. Reads `latestASPRoot()` at that block and the ASP's leaves, and refuses leaves that do not hash
   to that root.
3. Rebuilds the approved birth set (see Births).
4. Posts when the pool root or the birth root changed, or when 300 s of Aztec chain time passed since
   the last post. Before sending, it checks the registry's `post_root` assertions itself (sequence,
   non-zero root, monotonic block and time, observation lag ≤ 1800 s), so a refused post is a logged
   skip, not a failed transaction.

## Births

A label born on Aztec, by a labelled token's `shield`, joins the birth root once the bot approves
it. For each token in `config.tokens`, the bot's PXE holds the intake's keys and decrypts the
`BirthAnnouncement { label, secret, owner, amount }` events the token sends the registry's birth
intake. It approves one only when the announcement's own transaction proves it:

- the transaction succeeded, in a block at or below the tick's checkpointed block;
- `label` equals `birthLabel(token, owner, amount, secret)` (`@pp/bridge-spec/birth`);
- the same transaction carries the token's public `ShieldDebited { birth_id, owner, amount }` with
  `birth_id = birthId(label, secret)`, and the siloed birth nullifier.

The birth set, the sorted `hash_1(label)` of every approved birth, is rebuilt from the PXE on every
tick. A restart or a `set_poster` therefore loses no birth. While the PXE is behind the
checkpointed block, the tick posts nothing: a partial set would drop births from the root. Logs name
a refused birth by its transaction hash and a reason, never by an announced field.

### Handing the intake to the pool operator

The registry's admin calls `set_birth_intake(<their address>)`. Their script reads
`BirthAnnouncement` with their intake key, runs the checks above, and posts the sorted
`hash_1(label)` set as `birth_root`. Only the poster posts, so the full handoff is
`set_birth_intake` plus `set_poster` to their accounts. Only the previous intake's key reads the
births announced before the switch, and `set_poster` clears the record. So the previous holder
hands over its approved set first, and their first post carries that set plus every birth they have
read. A shield proven against an older anchor still delivers to the previous intake for up to
1800 s after the switch, so the previous holder also reads that window and passes those births on.

## Snapshots

| Route | Answer |
|---|---|
| `GET /v1/snapshots/latest` | The snapshot of the record the registry holds. |
| `GET /v1/snapshots/<sequence>` | That sequence, while held; else 404. |

Bodies are the `@pp/label-paths` wire format. Every answer is `cache-control: no-store` with no ETag,
because a sequence the bot no longer holds must never be served from a cache. Any method but `GET`
gets 405. `@pp/label-paths` recomputes both roots on parse, so the server cannot forge a path. It can
still leave a label out (see that package's README).

A post's sequence is served from the moment the bot sends it, because the record names it as soon as
the post is in a proposed block. `/latest` moves at the checkpoint. A 404 means this process does not
hold that sequence.

## Running it

`startBot(config)` starts the bot in its own process group and resolves once `/latest` serves. The
handle's `postNow()` asks for a post at once, and `stop()` stops the group, releases the bot's port
row and, with `removeDataOnStop`, deletes its wallet store. On the local network, the poster and
intake accounts derive from the stack's run id (`localBotAccounts`), so no key is configured.

## Tests

- Unit: `bun run --cwd packages/asp-bot test`.
- Against the local stack (after `bun run demo:prepare` once per clone):
  `bun run --cwd packages/asp-bot test:integration` boots `bun run demo`,
  deploys a registry, approves two labels on the mock ASP and checks the first post end to end
  (about 10 minutes).
