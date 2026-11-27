#!/usr/bin/env bash
# Installs Foundry from its release archive, checked against the SHA-256 below, and prepends the
# binaries' directory to GITHUB_PATH. It never runs foundryup, so it never reaches the attestation
# endpoint foundryup calls. Each run stages in a fresh private directory, so nothing a previous
# step left behind is reused.
set -euo pipefail

version=1.7.1
# foundry_v1.7.1_linux_amd64.tar.gz from foundry-rs/foundry's v1.7.1 release.
sha256=cf7e688ed0c4c48adffca788b496076e31060b67ac5afe1e43dbb5499c20c88b
tools=(forge cast anvil chisel)

if [ "${RUNNER_OS:-}" != Linux ] || [ "${RUNNER_ARCH:-}" != X64 ]; then
	echo "::error::setup-foundry pins the linux_amd64 archive; this runner is ${RUNNER_OS:-unknown}/${RUNNER_ARCH:-unknown}" >&2
	exit 1
fi

name="foundry_v${version}_linux_amd64.tar.gz"
work="$(mktemp -d "$RUNNER_TEMP/setup-foundry.XXXXXX")"
archive="$work/$name"
bin="$work/bin"
# -q first: a runner's curlrc must not change how the archive is fetched.
curl -q --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
	--retry 5 --retry-all-errors --retry-delay 5 --connect-timeout 20 --max-time 300 \
	--output "$archive" "https://github.com/foundry-rs/foundry/releases/download/v${version}/${name}"
echo "$sha256  $archive" | sha256sum --check --strict --quiet -

mkdir "$bin"
tar -xzf "$archive" -C "$bin" "${tools[@]}"
rm -f "$archive"
for tool in "${tools[@]}"; do
	out="$("$bin/$tool" --version)"
	line="${out%%$'\n'*}"
	if [ "$line" != "$tool Version: $version" ]; then
		echo "::error::$bin/$tool reports '$line', not $version" >&2
		exit 1
	fi
done
echo "$bin" >> "$GITHUB_PATH"
echo "Foundry $version from the checked archive: $bin"
