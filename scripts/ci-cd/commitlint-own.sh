#!/usr/bin/env bash
# Lints the commits a pull request brings: reachable from its head and from none of the excluded
# refs (its base, and main). A sync of main into an integration branch then lints only its merge
# commits, since main's history is out of that PR's hands; a PR to main lints what it always did.
#
#   commitlint-own.sh <head> <excluded-ref>...
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
head="${1:?usage: commitlint-own.sh <head> <excluded-ref>...}"
shift
[ "$#" -gt 0 ] || { echo "commitlint-own.sh: name at least the base to exclude" >&2; exit 2; }
excluded=()
for ref in "$@"; do excluded+=("^$ref"); done

# A failed rev-list (an unknown ref) fails here rather than reading as an empty range.
list="$(git rev-list --reverse "$head" "${excluded[@]}")"
[ -n "$list" ] || { echo "no commits of its own to lint"; exit 0; }

failed=0
while IFS= read -r sha; do
	echo "--- $(git log -1 --format='%h %s' "$sha")"
	git log -1 --format=%B "$sha" | "$root/node_modules/.bin/commitlint" --cwd "$root" || failed=1
done <<< "$list"
exit "$failed"
