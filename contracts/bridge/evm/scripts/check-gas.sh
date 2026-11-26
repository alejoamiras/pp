#!/usr/bin/env bash
# Gas snapshot within tolerance, and every metered case actually ran: `forge snapshot --check`
# compares only the cases that ran, so a deleted or renamed case would otherwise pass silently.
set -euo pipefail
cd "$(dirname "$0")/.."

forge snapshot --match-test test_gas_ --no-match-contract Fork --check --tolerance 2 2>&1 | tee gas.log
sed -E 's/\x1b\[[0-9;]*m//g' gas.log > gas.clean

fail=0
while read -r name; do
	grep -qE "^\[PASS\] ${name}\(" gas.clean || {
		echo "::error::gas case ${name} did not run and pass"
		fail=1
	}
done <<'CASES'
test_gas_createPortal_freshToken
test_gas_depositToAztecPublic
test_gas_depositToAztecPrivate
test_gas_withdraw
CASES
exit "$fail"
