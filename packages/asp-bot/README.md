# @pp/asp-bot

Posts the pool's ASP root to the ASP registry on Aztec and serves the snapshots that let a client
build a label path. Demo grade: snapshots live in memory, and a restart serves only what it posts next.

## What a tick does

1. Reads the registry's record and the Aztec tip, and selects one Ethereum block (`latest`, `safe` or
   `finalized`).
2. Reads `latestASPRoot()` at that block and the ASP's leaves, and refuses leaves that do not hash
   to that root.
3. Rebuilds the approved birth set (see Births).
4. Halts with `size_mismatch` when the record holds one of these roots with a list of another length.
   One root has one honest list, so one of the two lists is collapsed, and the feed must not replace
   the length on chain. It drops the list it fetched and asks the feed again every tick, so it resumes
   once the lengths agree. The log line names the list, both lengths and what to do: compare both
   lists with the ASP's published list; if the feed is wrong, fix it or restart the bot; if the posted
   length is wrong, fix the feed first, then the admin calls `set_poster`, which clears the record. A
   cleared record makes the bot fetch the feed again before it posts.
5. Posts when the pool root or the birth root changed, or when 300 s of Aztec chain time passed since
   the last post, with the length of each list. Before sending, it checks the registry's `post_root`
   assertions itself (sequence, non-zero root, monotonic block and time, observation lag ≤ 1800 s,
   lengths), so a refused post is a logged skip, not a failed transaction.

Each length is the one the bot built its root from, so the record commits the list the bot saw: a
feed that lied when the bot posted is not caught by any client (see `@pp/label-paths`).

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
gets 405. `@pp/label-paths` checks each list's length and root against the record, so the server can
neither forge a path nor leave a label out.

A post's sequence is served from the moment the bot sends it, because the record names it as soon as
the post is in a proposed block. `/latest` moves at the checkpoint. A 404 means this process does not
hold that sequence.

## Running it

`startBot(config)` starts the bot in its own process group and resolves once `/latest` serves. The
handle's `postNow()` asks for a post at once, and `stop()` stops the group, releases the bot's port
row and, with `removeDataOnStop`, deletes its wallet store. On the local network, the poster and
intake accounts derive from the stack's run id (`localBotAccounts`), so no key is configured.

## The ASP API

The bot reads the pool's leaves from `GET /association-set/leaves`. The standalone always scopes the query by
`chainId` and `entrypoint`, since one chain can host several pools. It treats the answer as untrusted:
- every request carries the User-Agent `pp-aztec-bridge-bot/<version>`; the standalone's `userAgent` may
  extend it but must keep that product token;
- a redirect fails;
- the deadline is 10 s for the whole body;
- an answer over 24 MiB, or with more than 2^18 leaves (the registry's list limit), is refused before it
  is parsed.

The leaves are used only when they hash to the root the ASP registry holds on Ethereum.

## Tests

- Unit: `bun run --cwd packages/asp-bot test`.
- Against the local stack (after `bun run demo:prepare` once per clone):
  `bun run --cwd packages/asp-bot test:integration` boots `bun run demo`, deploys a registry per
  suite and runs them end to end (about 10 minutes). `bot` checks the first post. `births` checks a
  shield's birth, the bot's outputs, and a revocation after which a path fetched before it fails
  `check_label`.
