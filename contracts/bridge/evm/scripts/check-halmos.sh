#!/usr/bin/env bash
# Symbolic proofs, checked by name. CI and the local gate both run this; `halmos` and the pinned
# Foundry must be on PATH, and remappings.txt generated (see the README).
set -euo pipefail
cd "$(dirname "$0")/.."

# --ast --force: halmos reads the solc AST from the artifacts, and a plain `forge build` writes them
# without it. Against those artifacts halmos does not fail: it reports "No tests with
# --match-contract" and exits 0, which passes for a missing suite.
forge build --ast --force
halmos --match-contract '^Formal' 2>&1 | tee halmos.log

# Counts alone cannot police this: halmos prints one summary per contract and no grand total, so a
# deleted proof file simply stops producing its line, and a renamed `check_` is invisible while the
# number stays right. Bind each expected count to the contract that must produce it, require every
# committed proof BY NAME to have passed, then require that nothing else ran and nothing failed.
# (halmos colors its output even into a pipe.)
sed -E 's/\x1b\[[0-9;]*m//g' halmos.log > halmos.clean
fail=0
while read -r n contract; do
	grep -qE "^Running ${n} tests for .*:${contract}\$" halmos.clean || {
		echo "::error::expected ${n} symbolic proofs in ${contract}; see the log above"
		fail=1
	}
done <<'EXPECTED'
2 FormalFactoryTest
10 FormalProcessorPortalTest
EXPECTED

while read -r proof; do
	grep -qE "^\[PASS\] ${proof}\(" halmos.clean || {
		echo "::error::symbolic proof ${proof} did not pass (missing, renamed, or failed)"
		fail=1
	}
done <<'PROOFS'
check_predictPortal_isCreate2OfInitcode
check_setEntriesPaused_revertsForNonOwner
check_bridge_valid_accountsExactly
check_settle_anyPause_paysExactly
check_bridge_paused_revertsBeforePool
check_bridge_badShape_revertsBeforePool
check_bridge_wrongToken_revertsBeforePool
check_bridge_secretHashOutOfRange_revertsBeforePool
check_bridge_overCap_revertsBeforePool
check_bridge_inexactPayment_reverts
check_settle_aboveReserve_reverts
check_settle_badPayeeOrLabel_reverts
PROOFS

summaries=$(grep -c '^Symbolic test result: ' halmos.clean || true)
if [ "$summaries" -ne 2 ]; then
	echo "::error::expected 2 proof contracts to run, saw ${summaries}"
	fail=1
fi
if grep -qE '^Symbolic test result: [0-9]+ passed; [1-9]' halmos.clean; then
	echo "::error::a symbolic proof failed; see the log above"
	fail=1
fi
exit "$fail"
