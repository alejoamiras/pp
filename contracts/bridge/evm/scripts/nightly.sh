#!/usr/bin/env bash
# The deep run behind the nightly workflow, at the `nightly` Foundry profile: every fuzz test at its
# run count, then the invariant campaigns at its depth through check-invariant.sh. Assumes lib/ and
# remappings.txt exist and the pinned Foundry is on PATH; forge's summaries stay on stdout, which
# the workflow parses.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=SCRIPTDIR/forge-ran.sh
source scripts/forge-ran.sh
export FOUNDRY_PROFILE=nightly

mkdir -p out
log=$(mktemp out/nightly-fuzz.XXXXXX)
trap 'rm -f "$log"' EXIT
forge test --match-test '^testFuzz' --no-match-contract Fork 2>&1 | tee "$log"
require_ran "$log" testFuzz
bash scripts/check-invariant.sh
