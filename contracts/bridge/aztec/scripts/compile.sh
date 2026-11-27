#!/usr/bin/env bash
# Compile + AVM-transpile the deployable L2 bridge contracts.
#
# These contracts pin aztec-nr at the v6.0.0 git tag, which needs the matching
# 6.0.0 toolchain. The `aztec` CLI + `bb` (the AVM transpiler) live under
# node_modules/.bin; nargo is exposed as `aztec-nargo` in bin/ (5.0 renamed the bundled
# bare binaries to aztec-* on PATH). Plain `nargo compile` produces a NON-transpiled
# artifact that aztec.js loadContractArtifact rejects ("public bytecode has not been
# transpiled"); `aztec compile` does nargo + transpile + VKs. Output: the postprocessed
# target/*.json (the deployable artifact).
#
#   compile.sh            rebuild every parity crate of contracts/crates.json in place (always a full
#                         build; the output is reproducible, so an unchanged source leaves the
#                         committed bytes as they are)
#   compile.sh --check    rebuild, then require each committed artifact to match: a contract's class id
#                         or a program's hash, and the ABI (scripts/noir-artifact-parity.ts). The
#                         committed bytes are restored either way. Exit 1 on any drift.
#   compile.sh [--check] <crate>...   restrict to the named manifest crates
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
top="$(cd "$here/../../.." && pwd)"
contracts_dir="$top/contracts"
bridge_core="$top/packages/bridge-core"
crates() { (cd "$top" && bun scripts/ci-cd/crates.ts "$@"); }

AZTEC_HOME="${AZTEC_HOME:-$HOME/.aztec/versions/$(crates aztec-version)}"
AZTEC="$AZTEC_HOME/node_modules/.bin/aztec"
[ -x "$AZTEC" ] || { echo "aztec CLI not found at $AZTEC — run: aztec-up install $(crates aztec-version)" >&2; exit 1; }

export PATH="$AZTEC_HOME/bin:$AZTEC_HOME/node_modules/.bin:$PATH"
export NARGO="$AZTEC_HOME/bin/aztec-nargo"
export BB="$AZTEC_HOME/node_modules/.bin/bb"

# Puts the JSON moved aside into $committed back in $dir/target/, replacing whatever the build wrote.
# Safe to run again: the build's output is deleted once, and a backup a failed move left stays put.
restore_committed() {
	local f
	[ -d "$committed" ] || return 0
	if [ "$built" = 1 ]; then
		rm -f "$dir"/target/*.json
		built=0
	fi
	for f in "$committed"/*.json; do [ ! -e "$f" ] || mv -f "$f" "$dir/target/"; done
	rmdir "$committed"
}

check=0
names=()
for arg in "$@"; do
	case "$arg" in
		--check) check=1 ;;
		*) names+=("$arg") ;;
	esac
done
[ ${#names[@]} -gt 0 ] || mapfile -t names < <(crates list parity)
[ ${#names[@]} -gt 0 ] || { echo "contracts/crates.json lists no parity crate" >&2; exit 1; }

drift=0
for c in "${names[@]}"; do
	echo "=== aztec compile $c ==="
	# Kind from the manifest, never from the artifact under test: a truncated artifact must not pick
	# its own check.
	kind="$(crates get "$c" kind)"
	dir="$top/$(crates get "$c" path)"
	[ "$kind" != lib ] || { echo "✖ $c: a lib crate builds no artifact" >&2; exit 1; }
	# `aztec compile` skips the build unless a source is newer than the OLDEST target/*.json, and a
	# checkout, a restore or the TXE runner's staged Token copy can leave any mtimes there. Every
	# JSON is moved aside to force the build, inside target/ so each move is a rename that cannot
	# half-copy. A failed move stops the script before the build; the trap deletes target/'s JSON only
	# once every original is aside, then puts the originals back.
	mkdir -p "$dir/target"
	committed="$(mktemp -d "$dir/target/.committed.XXXXXX")"
	built=0
	trap 'restore_committed' EXIT
	tracked="$(cd "$dir" && git ls-files -- target | xargs -r -n1 basename)"
	for f in "$dir"/target/*.json; do [ ! -e "$f" ] || mv "$f" "$committed/"; done
	built=1
	(cd "$dir" && "$AZTEC" compile)
	# `aztec compile` embeds absolute source paths (this machine's checkout + the ~/.aztec and
	# ~/nargo dependency caches) in the artifact's debug file_map. They are not load-bearing, but
	# the artifact is committed (CI has no nargo), so leaving them leaks the contributor's home-dir
	# layout and trips scripts/check-no-local-paths.sh. Rewrite them relative to contracts/ so the
	# committed artifact is identical regardless of which machine built it.
	perl -i -pe "s{\Q$contracts_dir\E/}{}g; s{\Q$HOME\E/}{}g" "$dir"/target/*.json
	if [ "$check" = 1 ]; then
		[ -n "$tracked" ] || { echo "✖ $c: no committed artifact to compare against" >&2; drift=1; }
		for name in $tracked; do
			if [ ! -f "$dir/target/$name" ]; then
				echo "✖ $c: the source no longer produces $name" >&2
				drift=1
			elif (cd "$bridge_core" && bun scripts/noir-artifact-parity.ts "$kind" "$committed/$name" "$dir/target/$name"); then
				echo "✔ $c: $name matches its source"
			else
				echo "✖ $c: $name drifted from its source" >&2
				drift=1
			fi
		done
		# --check never dirties the tree; a renamed contract's fresh JSON must not survive beside the
		# restored set.
		restore_committed
	fi
	rm -rf "$committed"
	trap - EXIT
done
if [ "$check" = 1 ]; then
	[ "$drift" = 0 ] && echo "✅ committed artifacts match their sources (binding and ABI)" || exit 1
else
	echo "✅ transpiled + path-scrubbed artifacts in place"
fi
