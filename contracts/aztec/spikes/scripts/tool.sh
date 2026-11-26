#!/bin/sh
# Runs a binary from the pinned Aztec toolchain; never from ~/.aztec/current, which other sessions repoint.
set -eu
tool="$1"
shift
exec "${AZTEC_HOME:-$HOME/.aztec/versions/6.0.0}/bin/$tool" "$@"
