# shellcheck shell=bash
# Sourced by the gate scripts. A FOUNDRY_* filter in the caller's environment narrows what forge
# runs, and forge exits 0 on an empty match, so the gates clear the filters and then check the count.
unset FOUNDRY_MATCH_TEST FOUNDRY_NO_MATCH_TEST FOUNDRY_MATCH_CONTRACT FOUNDRY_NO_MATCH_CONTRACT \
	FOUNDRY_MATCH_PATH FOUNDRY_NO_MATCH_PATH FOUNDRY_TEST

# require_ran LOG PREFIX: forge's summary in LOG must count exactly the `function PREFIX...` tests
# declared under test/, every one passed and none skipped.
require_ran() {
	local want got
	want=$(grep -rhoE "function ${2}[A-Za-z0-9_]*" test | grep -c .)
	got=$(grep -oE '[0-9]+ tests passed, 0 failed, 0 skipped \([0-9]+ total tests\)' "$1" | tail -1 | grep -oE '^[0-9]+' || true)
	if [ "${got:-0}" != "$want" ]; then
		echo "::error::forge ran ${got:-0} of the ${want} ${2} tests under test/"
		return 1
	fi
}
