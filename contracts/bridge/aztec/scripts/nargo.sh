#!/usr/bin/env bash
# Runs the pinned aztec-nargo in a crate directory: scripts/nargo.sh <crate-dir> <nargo args...>
# The crates pin one aztec-nr tag (contracts/crates.json); the default toolchain on PATH may differ and fails
# with a flood of macro errors, so every local invocation goes through this wrapper.
set -euo pipefail
version="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && bun scripts/ci-cd/crates.ts aztec-version)"
AZTEC_HOME="${AZTEC_HOME:-$HOME/.aztec/versions/$version}"
NARGO="$AZTEC_HOME/bin/aztec-nargo"
[ -x "$NARGO" ] || { echo "aztec-nargo not found at $NARGO — run: aztec-up install $version" >&2; exit 1; }
crate="$1"; shift
cd "$crate"
exec "$NARGO" "$@"
