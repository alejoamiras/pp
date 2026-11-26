#!/usr/bin/env bash
# The deep run behind the nightly workflow, at the `nightly` Foundry profile: every fuzz test at its
# run count, then the invariant campaigns at its depth through check-invariant.sh. Assumes lib/ and
# remappings.txt exist and the pinned Foundry is on PATH; forge's summaries stay on stdout, which
# the workflow parses.
set -euo pipefail
cd "$(dirname "$0")/.."
export FOUNDRY_PROFILE=nightly

mkdir -p out
forge test --match-test '^testFuzz' --no-match-contract Fork 2>&1 | tee out/nightly-fuzz.log
# forge exits 0 when nothing matches, so require at least one passing suite.
grep -qE '^Suite result: ok\. [1-9]' out/nightly-fuzz.log || {
	echo "::error::no fuzz test ran"
	exit 1
}
bash scripts/check-invariant.sh
