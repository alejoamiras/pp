#!/usr/bin/env bash

set -euo pipefail

# Home directories on macOS and Linux, and data volumes mounted two levels under /mnt.
pattern='/Users/[A-Za-z]|/home/[A-Za-z]|/mnt/[A-Za-z][A-Za-z0-9_-]*/[A-Za-z]'

mapfile -t hits < <(
	git grep -i -l -E "$pattern" -- \
		. \
		':!scripts/check-no-local-paths.sh' || true
)

if ((${#hits[@]} > 0)); then
	printf '%s\n' 'absolute local path detected:' >&2
	printf ' - %s\n' "${hits[@]}" >&2
	printf '%s\n' 'Rewrite to a repo-relative path, or extend the allowlist in scripts/check-no-local-paths.sh if the path is not a local-machine leak.' >&2
	exit 1
fi

printf '%s\n' 'ok: no absolute local paths found'
