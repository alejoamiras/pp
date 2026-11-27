# @pp/run-isolation

The primitives a local run uses to own its ports and processes and tear down only what it started.
Node-only, no dependencies.

| Export | What it is |
|---|---|
| `@pp/run-isolation/lock` | `withFileLock`: an `O_EXCL` lock file holding its owner's token. A live holder renews it; one older than `staleMs` is a dead holder's and is reclaimed. |
| `@pp/run-isolation/ports` | Claims in the host registry `~/.agents/ports.md` (`PP_PORTS_REGISTRY` overrides it), shared with every other run on the machine: `claimPort`, `releasePorts`, `registeredPorts`, `rowsOwnedBy`. Ports come from a static window below the OS ephemeral range. |
| `@pp/run-isolation/process` | `spawnOwned` starts a child as its own group leader; `killGroup` signals only that group; `CleanupStack` runs teardown steps in reverse, on SIGINT and SIGTERM too. |
| `@pp/run-isolation/process-group` | `groupAlive`, `groupGone`, `endGroup` and `groupMembers` for one process group. On Linux a member counts while one of its threads runs, read from `/proc`, so a zombie its reaper has not collected yet reads as gone. Elsewhere a group counts while the kernel lets it be signalled. |

A package that signals a process group imports it from here rather than calling `process.kill` on a
negative pid itself.
