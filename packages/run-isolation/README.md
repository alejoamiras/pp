# @pp/run-isolation

The primitives a local run uses to own its ports and processes and tear down only what it started.
Node-only, no dependencies.

| Export | What it is |
|---|---|
| `@pp/run-isolation/lock` | `withFileLock`: an `O_EXCL` lock file holding its owner's token. A live holder renews it; one older than `staleMs` is a dead holder's and is reclaimed. |
| `@pp/run-isolation/ports` | Claims in the host registry `~/.agents/ports.md` (`PP_PORTS_REGISTRY` overrides it), shared with every other run on the machine: `claimPort`, `claimRows` (several ports in one write), `releasePorts` / `releaseRows`, `releaseNamed` (exactly the rows named by port, service and owner), `registeredPorts`, `rowsOwnedBy`, `portOwner`. A run owns exactly the rows whose owner column is its id; a `sole` claim fails with `OwnerHoldsRows` when its owner already holds one. Ports come from a static window below the OS ephemeral range. |
| `@pp/run-isolation/process` | `spawnWatched` starts a command in a group that ends when the spawning process dies, SIGKILL included: its leader, `watch.ts`, holds a pipe only the parent writes to, and on end-of-file sends the group SIGTERM, waits out a grace, releases the rows the caller named once no other member runs, and otherwise SIGKILLs the group and leaves the rows. `spawnOwned` does the same with both streams in a log file (a command writing into a pipe whose reader died may never stop), or `own` tracks a child already spawned with `detached: true`; `killGroup` sends SIGTERM while the leader runs, then SIGKILL to whatever in that group is still running, and never signals a group number a stranger now holds; `CleanupStack` runs teardown steps in reverse, on SIGINT and SIGTERM too. |
| `@pp/run-isolation/process-group` | `groupAlive`, `groupGone`, `endGroup`, `signalGroup` and `groupMembers` for one process group. On Linux a member counts while one of its threads runs, read from `/proc`, so a zombie its reaper has not collected yet reads as gone. Elsewhere a group counts while the kernel lets it be signalled. `startTime` and `pidNamespace` name one process across pid reuse and containers (Linux only). |

A package that signals a process group imports it from here rather than calling `process.kill` on a
negative pid itself.
