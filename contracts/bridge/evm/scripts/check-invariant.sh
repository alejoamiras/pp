#!/usr/bin/env bash
# The invariant campaigns, under whatever FOUNDRY_PROFILE is set. Each run of
# ProcessorPortalInvariant appends `replays,forgedSettles,capHits,reserveHits,calls,reverts` to
# out/invariant-stats. A campaign that never replayed a settled ticket, settled under a forged root,
# hit the cap or hit the reserve proves nothing about those paths, so each total must be non-zero.
# forge exits 0 when no test matches, so a missing stats file fails too. Needs lib/, remappings.txt
# and the pinned Foundry on PATH (see the README).
set -euo pipefail
cd "$(dirname "$0")/.."

stats=out/invariant-stats/ProcessorPortalInvariant.csv
rm -f "$stats"
forge test --match-contract Invariant
if [ ! -s "$stats" ]; then
	echo "::error::${stats} is missing: no invariant campaign ran (forge exits 0 on an empty match)"
	exit 1
fi
awk -F, '
	{ replays += $1; forged += $2; cap += $3; reserve += $4; calls += $5; reverts += $6 }
	END {
		printf "portal campaign: %d runs, %d handler calls, %d reverted (%.1f%%)\n", NR, calls, reverts, 100 * reverts / calls
		printf "  replays of settled tickets %d, forged-root settles %d, cap hits %d, ExceedsReserve hits %d\n", replays, forged, cap, reserve
		if (replays == 0 || forged == 0 || cap == 0 || reserve == 0) {
			print "::error::the portal campaign never reached one of the paths above"
			exit 1
		}
	}' "$stats"
