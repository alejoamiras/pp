#!/usr/bin/env bash
# Installs the forge libraries into lib/ (gitignored) at the commits the suites were validated
# against. Commits, not tags: resolving a different forge-std is a silent divergence, and an older
# one made halmos abort in setUp with "Unsupported cheat code", passing nothing.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# `forge install` refuses an existing directory, and without git metadata an existing copy cannot
# be checked against the commit, so a rerun starts from empty.
rm -rf lib/forge-std lib/openzeppelin-contracts
forge install --no-git \
	foundry-rs/forge-std@bf647bd6046f2f7da30d0c2bf435e5c76a780c1b \
	OpenZeppelin/openzeppelin-contracts@cab19933c33c2ad1d4c7a84864a3601dddfd16f3
