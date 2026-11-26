#!/usr/bin/env bash
# pool-client's suites that need the fetched checkout (proof, integration against `pp-env up`,
# Chromium), with no route off the machine. CI runs the `outer` stage as root inside
# `unshare --net`: it brings up loopback alone, proves that, and drops to the runner user, who
# checks the tools and the missing egress before running the suites.
#
#   sudo unshare --net -- offline-gate.sh outer <uid> <gid> <home> <path> <pp-forge>
#
# This isolates IP egress only; host filesystem sockets are a separate boundary.
set -euo pipefail

fail() {
	echo "::error::$*" >&2
	exit 1
}

outer() {
	local uid=$1 gid=$2 home=$3 path=$4 forge=$5 up
	ip link set lo up
	up="$(ip -o link show up | awk -F': ' '{print $2}' | tr '\n' ' ')"
	[ "$up" = "lo " ] || fail "interfaces up besides loopback: $up"
	exec setpriv --reuid "$uid" --regid "$gid" --clear-groups --no-new-privs -- \
		env -i HOME="$home" PATH="$path" PP_FORGE="$forge" LANG=C.UTF-8 bash "$0" inner
}

inner() {
	local rc=0
	[ "$(bun --version)" = "1.4.2" ] || fail "bun is $(bun --version), not 1.4.2"
	[ -x "$HOME/.aztec/versions/6.0.0/bin/aztec-anvil" ] || fail "no Aztec 6.0.0 anvil under $HOME/.aztec"
	[ -d "$HOME/.cache/ms-playwright" ] || fail "no Playwright browsers under $HOME/.cache/ms-playwright"
	curl --max-time 3 -sS -o /dev/null http://1.1.1.1 || rc=$?
	[ "$rc" -eq 7 ] || fail "curl to 1.1.1.1 exited $rc; expected 7, a connect error"
	# shellcheck disable=SC2016 # JavaScript source, not shell.
	bun -e '
		const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") })
		const body = await (await fetch(server.url)).text()
		server.stop(true)
		if (body !== "ok") throw new Error(`loopback answered ${body}`)
	'
	local run=(bun run --cwd packages/pool-client)
	"${run[@]}" test:proof:node
	"${run[@]}" test:proof
	"${run[@]}" test:integration:node
	"${run[@]}" test:integration
	"${run[@]}" test:browser
	"${run[@]}" test:browser:integration
}

case "${1:-}" in
outer) shift && outer "$@" ;;
inner) inner ;;
*) fail "usage: offline-gate.sh outer <uid> <gid> <home> <path> <pp-forge>" ;;
esac
