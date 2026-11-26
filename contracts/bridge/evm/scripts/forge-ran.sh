# shellcheck shell=bash
# Sourced by the gate scripts. Any FOUNDRY_* variable in the caller's environment overrides
# foundry.toml (a filter, a run count, a depth, another config file), and forge exits 0 on an empty
# match, so the gates clear all of them but FOUNDRY_PROFILE, then check the count.
while IFS= read -r var; do
	[ "$var" = FOUNDRY_PROFILE ] || unset "$var"
done < <(compgen -e | grep '^FOUNDRY_' || true)

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
