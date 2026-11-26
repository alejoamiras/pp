#!/usr/bin/env bash
# Lints the subject a squash merge writes, "<title> (#<number>)", whose suffix counts toward the
# length limit. The title comes in PR_TITLE and reaches commitlint on stdin, never through the
# script's text, so a title is data whatever it contains. commitlint-title.json turns off the
# default ignores ("Merge …", "Automatic merge …"): a title is always ours to write.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
: "${PR_TITLE?PR_TITLE is unset}"
[[ "${PR_NUMBER:-}" =~ ^[0-9]+$ ]] || { echo "lint-pr-title.sh: PR_NUMBER must be a number" >&2; exit 2; }
printf '%s (#%s)\n' "$PR_TITLE" "$PR_NUMBER" | "$root/node_modules/.bin/commitlint" --cwd "$root" --config "$root/scripts/ci-cd/commitlint-title.json"
