#!/usr/bin/env bash
# The invariant campaigns, under whatever FOUNDRY_PROFILE is set. Each run of
# ProcessorPortalInvariant appends `replays,forgedLanded,capHits,reserveHits,guardHits,calls,reverts`
# to a stats file this invocation owns. A campaign in which the Outbox never refused a replay, no
# forged payout landed, or the cap, the reserve or the reentrancy guard never refused proves nothing
# about those paths, so each total must be non-zero. Each PortalFactoryInvariant run appends
# `handoffs,newOwnerPauses,refusedTransfers,refusedAccepts,refusedRenounces` to another; a walk that
# never handed ownership over, never paused under a new owner, or never had a stranger's transfer,
# accept or a renounce refused proves nothing about the handoff, so each of those totals must be
# non-zero too. Every `invariant_` under test/ must have run.
# The selection is by test name, so it complements CI's hermetic run (`--no-match-test '^invariant_'`)
# whatever the contracts are called. Needs lib/, remappings.txt and the pinned Foundry on PATH (see
# the README).
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=SCRIPTDIR/forge-ran.sh
source scripts/forge-ran.sh

mkdir -p out/invariant-stats
stats=$(mktemp out/invariant-stats/ProcessorPortalInvariant.XXXXXX)
factory=$(mktemp out/invariant-stats/PortalFactoryInvariant.XXXXXX)
log=$(mktemp out/invariant-stats/forge.XXXXXX)
trap 'rm -f "$stats" "$factory" "$log"' EXIT
PORTAL_INVARIANT_STATS=$stats FACTORY_INVARIANT_STATS=$factory forge test --match-test '^invariant_' --no-match-contract Fork | tee "$log"
require_ran "$log" invariant_
for f in "$stats" "$factory"; do
	if [ ! -s "$f" ]; then
		echo "::error::$(basename "${f%.*}") wrote no campaign stats"
		exit 1
	fi
done
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
awk -F, '
	{ handoffs += $1; pauses += $2; transfers += $3; accepts += $4; renounces += $5 }
	END {
		printf "factory runs: %d, handoffs %d, pauses by a new owner %d, refused transfers %d, refused accepts %d, refused renounces %d\n", NR, handoffs, pauses, transfers, accepts, renounces
		if (handoffs == 0 || pauses == 0 || transfers == 0 || accepts == 0 || renounces == 0) {
			print "::error::the factory runs never reached one of the paths above"
			exit 1
		}
	}' "$factory"
