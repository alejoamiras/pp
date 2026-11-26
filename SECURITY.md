# Security

This repository is a proof of concept. Nothing in it is deployed with real funds.

## Reporting a vulnerability

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/alejoamiras/pp/security/advisories/new). Do not
open a public issue. Include the affected path, the steps that show the problem and what an attacker
gains.

## Dependency policy

- `bunfig.toml` blocks any npm version younger than 7 days (`minimumReleaseAge`) when Bun resolves
  one. An install from an unchanged `bun.lock` resolves nothing, so `--frozen-lockfile` installs
  whatever the lockfile names: review a lockfile change as code. For a CVE fix that
  is newer than that, add the package to `minimumReleaseAgeExcludes`, install the fix, and remove the
  entry again in the same pull request; `bun install --frozen-lockfile --force` proves the lockfile
  no longer needs it.
- The Nulo wallet's `@nulo-sh/*` packages are standing exemptions: each publishes from one
  repository's workflow with npm provenance, and every pin on it here is exact.
- CI installs with `--frozen-lockfile`, pins every action by commit, and runs `bun audit` as an
  advisory step.
