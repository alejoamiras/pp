#!/usr/bin/env bash
# The invariant campaigns, under whatever FOUNDRY_PROFILE is set. Each run of
# ProcessorPortalInvariant appends `replays,forgedLanded,capHits,reserveHits,guardHits,calls,reverts`
# to a stats file this invocation owns. A campaign in which the Outbox never refused a replay, no
# forged payout landed, or the cap, the reserve or the reentrancy guard never refused proves nothing
# about those paths, so each total must be non-zero, and every `invariant_` under test/ must have run.
# The selection is by test name, so it complements CI's hermetic run (`--no-match-test '^invariant_'`)
# whatever the contracts are called. Needs lib/, remappings.txt and the pinned Foundry on PATH (see
# the README).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=SCRIPTDIR/forge-ran.sh
source scripts/forge-ran.sh

mkdir -p out/invariant-stats
stats=$(mktemp out/invariant-stats/ProcessorPortalInvariant.XXXXXX)
log=$(mktemp out/invariant-stats/forge.XXXXXX)
trap 'rm -f "$stats" "$log"' EXIT
PORTAL_INVARIANT_STATS=$stats forge test --match-test '^invariant_' --no-match-contract Fork | tee "$log"
require_ran "$log" invariant_
if [ ! -s "$stats" ]; then
	echo "::error::ProcessorPortalInvariant wrote no campaign stats"
	exit 1
fi
awk -F, '
	{ replays += $1; forged += $2; cap += $3; reserve += $4; guard += $5; calls += $6; reverts += $7 }
	END {
		printf "portal campaign: %d runs, %d handler calls, %d reverted (%.1f%%)\n", NR, calls, reverts, 100 * reverts / calls
		printf "  replays the Outbox refused %d, forged payouts landed %d, cap hits %d, ExceedsReserve hits %d, guard hits %d\n", replays, forged, cap, reserve, guard
		if (replays == 0 || forged == 0 || cap == 0 || reserve == 0 || guard == 0) {
			print "::error::the portal campaign never reached one of the paths above"
			exit 1
		}
	}' "$stats"
