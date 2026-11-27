# @pp/run-isolation

The primitives a local run uses to own its processes and tear down only what it started. Node-only,
no dependencies.

| Export | What it is |
|---|---|
| `@pp/run-isolation/process-group` | `groupAlive`, `groupGone`, `endGroup` and `groupMembers` for one process group. On Linux a member counts while one of its threads runs, read from `/proc`, so a zombie its reaper has not collected yet reads as gone. Elsewhere a group counts while the kernel lets it be signalled. |

A package that signals a process group imports it from here rather than calling `process.kill` on a
negative pid itself.
