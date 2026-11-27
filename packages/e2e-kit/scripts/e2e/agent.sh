#!/usr/bin/env bash
# The browser suite, one run = one network: ports → network up → test-wallet build → app build →
# bundle assertions → playwright → reap. Parallelism is `--shard=i/n` across separate runs.
#
#   bun run --cwd packages/e2e-kit test:browser [-- <playwright args, e.g. --shard=1/2>]
#   bun run --cwd packages/e2e-kit test:browser reap    # stop every network a run of THIS checkout left behind
#
# PP_E2E_MODE picks the network. `sandbox` (the default): the bridge sandbox, and `apps/web`'s
# `build:local` against PP_SANDBOX_ARTIFACTS (the fixture world). `stack`: the local stack
# (`scripts/e2e/stack.ts`), and `build:local` against its PP_STACK_MANIFEST, served by the app's own
# `serve`. Either way the wallet URLs go in PP_WEB_WALLETS and the specs live in `apps/web/e2e`. A
# checkout without the app stops after the wallet build, which still proves the network boots and
# the wallet bundles against it.
#
# Iterating: PP_E2E_KEEP=1 leaves the network and the builds alive and prints the attach line;
# PP_E2E_ATTACH=<that state dir> reuses them (PP_E2E_REBUILD=1 to rebuild).
# Every process this script starts is its own process group; the trap stops exactly those groups.
set -euo pipefail
# Every CI runner starts with a cold Bun transpiler cache, and a warm one can hide failures.
export BUN_RUNTIME_TRANSPILER_CACHE_PATH=0

cd "$(dirname "$0")/../.."
KIT_DIR=$(pwd)
REPO_DIR=$(cd ../.. && pwd)
APP_DIR="$REPO_DIR/apps/web"
MODE="${PP_E2E_MODE:-sandbox}"
# A boot that fails clears this: nothing it left is worth keeping.
KEEP="${PP_E2E_KEEP:-}"
case "$MODE" in
  sandbox|stack) ;;
  *) echo "[e2e] FATAL: PP_E2E_MODE is '$MODE'; use sandbox or stack" >&2; exit 2 ;;
esac

# A state dir's browser ports go back only once no stack.pid names a stack it may still own: an
# attach reads them from ports.json, and the `reap` that stops that stack releases them then.
release_ports() {
  [ -f "$1/ports.json" ] || return 0
  if [ -f "$1/stack.pid" ]; then echo "[e2e] ports kept: $1/stack.pid still names a stack"; return 0; fi
  bun scripts/e2e/resolve-ports.ts --release "$1" 2>/dev/null || true
}

# Orphan recovery by OWNERSHIP: only the pgids this checkout's runs wrote to their pid files — never
# a name match, which would take down another agent's network on the same host.
if [ "${1:-}" = "reap" ]; then
  found=0
  for pidfile in "$KIT_DIR"/.e2e-state/*/sandbox.pid; do
    [ -f "$pidfile" ] || continue
    pgid=$(cat "$pidfile")
    statedir=$(dirname "$pidfile")
    # A number alone is not ownership: the kernel recycles pids, so the group's leader must still be
    # the sandbox command this run started, named by its own artifacts dir, or the file is stale.
    args=$(ps -o args= -p "$pgid" 2>/dev/null || true)
    if [ -n "$pgid" ] && kill -0 -- "-$pgid" 2>/dev/null && [[ "$args" == *" --artifacts $statedir/sandbox" ]]; then
      found=1
      echo "[e2e] reaping sandbox pgid $pgid ($(dirname "$pidfile"))"
      kill -TERM -- "-$pgid" 2>/dev/null || true
      for _ in $(seq 1 60); do kill -0 -- "-$pgid" 2>/dev/null || break; sleep 1; done
      kill -KILL -- "-$pgid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
    # The run's browser ports: ports.json names the owner its rows were claimed under.
    release_ports "$statedir"
  done
  # Stacks: `stack.ts down` stops a group only while it still leads the CLI that state dir started.
  for pidfile in "$KIT_DIR"/.e2e-state/*/stack.pid ${PP_E2E_STATE_DIR:+"$PP_E2E_STATE_DIR/stack.pid"}; do
    [ -f "$pidfile" ] || continue
    found=1
    statedir=$(dirname "$pidfile")
    bun scripts/e2e/stack.ts down "$statedir" || true
    release_ports "$statedir"
  done
  [ "$found" = 1 ] || echo "[e2e] nothing to reap"
  exit 0
fi
RUN_ID="browser-e2e-$$-$(date +%s | tail -c 6)"
STATE_DIR="${PP_E2E_ATTACH:-${PP_E2E_STATE_DIR:-$KIT_DIR/.e2e-state/$RUN_ID}}"
mkdir -p "$STATE_DIR"
# The handle the test wallet builds from: the sandbox's own, or the one `stack.ts up` writes.
if [ "$MODE" = stack ]; then ARTIFACTS="$STATE_DIR/wallet"; else ARTIFACTS="$STATE_DIR/sandbox"; fi
APP_DIST="$STATE_DIR/app-dist"
WALLET_DIST="$STATE_DIR/wallet-dist"
LOG="$STATE_DIR/sandbox.log"
SANDBOX_PID=""
STACK_BOOTED=0

log() { echo "[e2e] $*"; }

# shellcheck disable=SC2317,SC2329  # invoked by the EXIT trap; shellcheck before 0.11 calls it SC2317
stop_stack() {
  [ "$STACK_BOOTED" = 1 ] || return 0
  if [ "$KEEP" = "1" ]; then
    log "stack kept — attach with: PP_E2E_MODE=stack PP_E2E_ATTACH=$STATE_DIR bun run --cwd packages/e2e-kit test:browser -- <args>; stop with: bun run --cwd packages/e2e-kit test:browser reap (with PP_E2E_STATE_DIR=$STATE_DIR)"
    return 0
  fi
  bun scripts/e2e/stack.ts down "$STATE_DIR" || log "WARN: the stack did not stop cleanly — run: PP_E2E_STATE_DIR=$STATE_DIR bun run --cwd packages/e2e-kit test:browser reap"
}

# shellcheck disable=SC2317,SC2329  # invoked by the EXIT trap; shellcheck before 0.11 calls it SC2317
reap() {
  stop_stack
  if [ -n "$SANDBOX_PID" ] && kill -0 "$SANDBOX_PID" 2>/dev/null; then
    if [ "$KEEP" = "1" ]; then
      log "sandbox kept (pgid $SANDBOX_PID) — attach with: PP_E2E_ATTACH=$STATE_DIR bun run --cwd packages/e2e-kit test:browser -- <args>; stop with: kill -TERM -- -$SANDBOX_PID"
      return
    fi
    log "stopping sandbox (pgid $SANDBOX_PID)"
    kill -TERM -- "-$SANDBOX_PID" 2>/dev/null || true
    for _ in $(seq 1 60); do kill -0 "$SANDBOX_PID" 2>/dev/null || break; sleep 1; done
    kill -KILL -- "-$SANDBOX_PID" 2>/dev/null || true
  fi
  # A pid file that outlives its group would let a later `reap` mistake a recycled pgid for ours —
  # ours alone: an attached run never booted the sandbox it used and leaves the keeper's file be.
  if [ -n "$SANDBOX_PID" ] && [ "$KEEP" != "1" ]; then rm -f "$STATE_DIR/sandbox.pid"; fi
  # The browser ports' registry rows belong to this run alone; a kept run keeps them claimed.
  if [ "$KEEP" != "1" ] && [ -z "${PP_E2E_ATTACH:-}" ]; then release_ports "$STATE_DIR"; fi
}
trap reap EXIT

boot_sandbox() {
  log "booting the sandbox (log: $LOG)"
  setsid bun run --cwd "$REPO_DIR/packages/bridge-core" sandbox:up --artifacts "$ARTIFACTS" >"$LOG" 2>&1 &
  SANDBOX_PID=$!
  echo "$SANDBOX_PID" >"$STATE_DIR/sandbox.pid"
  for _ in $(seq 1 600); do
    if [ -f "$ARTIFACTS/handle.json" ] && grep -q "sandbox up" "$LOG"; then break; fi
    if ! kill -0 "$SANDBOX_PID" 2>/dev/null; then KEEP=0; log "FATAL: the sandbox died while booting — see $LOG"; tail -40 "$LOG" >&2; exit 2; fi
    sleep 2
  done
  [ -f "$ARTIFACTS/handle.json" ] || { KEEP=0; log "FATAL: sandbox did not come up in 20 min"; exit 2; }
}

attach_sandbox() {
  [ -f "$ARTIFACTS/handle.json" ] || { log "FATAL: $ARTIFACTS/handle.json missing — nothing to attach to"; exit 2; }
  local node
  node=$(jq -r .nodeUrl "$ARTIFACTS/handle.json")
  curl -sf -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"node_getNodeInfo","params":[]}' "$node" >/dev/null \
    || { log "FATAL: the kept $MODE at $node does not answer — start a fresh run"; exit 2; }
  log "attached to the kept $MODE at $node"
}

boot_stack() {
  log "booting the local stack (log: $STATE_DIR/stack.log)"
  # Set first: an interrupt mid-boot must still stop the group `up` has already started.
  STACK_BOOTED=1
  # A failed `up` has ended its group or left the record `down` retries; either way nothing is kept.
  bun scripts/e2e/stack.ts up "$STATE_DIR" || { KEEP=0; log "FATAL: the local stack did not come up — see $STATE_DIR/stack.log"; tail -40 "$STATE_DIR/stack.log" >&2; exit 2; }
}

build_wallet() {
  log "building the test wallet → $WALLET_DIST"
  PP_SANDBOX_ARTIFACTS="$ARTIFACTS" PP_APP_ORIGIN="$APP_ORIGIN" PP_TEST_WALLET_OUT_DIR="$WALLET_DIST" \
    bun run build:test-wallet >"$STATE_DIR/build-wallet.log" 2>&1
  grep -rqF -- "$NODE_URL" "$WALLET_DIST/assets" || { log "FATAL: the wallet bundle does not name the node $NODE_URL"; exit 2; }
}

build_app() {
  log "building apps/web (local target, $MODE) → $APP_DIST"
  if [ "$MODE" = stack ]; then
    PP_STACK_MANIFEST="$STACK_MANIFEST" PP_WEB_WALLETS="$WEB_WALLETS" \
      bun run --cwd "$APP_DIR" build:local -- --outDir "$APP_DIST" >"$STATE_DIR/build-app.log" 2>&1
  else
    PP_SANDBOX_ARTIFACTS="$ARTIFACTS" PP_WEB_WALLETS="$WEB_WALLETS" \
      bun run --cwd "$APP_DIR" build:local -- --outDir "$APP_DIST" >"$STATE_DIR/build-app.log" 2>&1
  fi
  grep -rqF -- "$NODE_URL" "$APP_DIST/assets" || { log "FATAL: the app bundle does not name the node $NODE_URL"; exit 2; }
  for url in "$WALLET_ORIGIN_PLAIN/?profile=plain" "$WALLET_ORIGIN_FULL/?profile=full"; do
    grep -rqF -- "$url" "$APP_DIST/assets" || { log "FATAL: the app bundle does not list the test wallet at $url"; exit 2; }
  done
}

if [ -n "${PP_E2E_ATTACH:-}" ]; then
  [ -f "$STATE_DIR/ports.json" ] || { log "FATAL: $STATE_DIR/ports.json missing — nothing to attach to"; exit 2; }
else
  log "resolving ports"
  bun scripts/e2e/resolve-ports.ts "$STATE_DIR" "$RUN_ID" "$$"
fi
APP_PORT=$(jq -r .app "$STATE_DIR/ports.json")
WALLET_PORT_PLAIN=$(jq -r .walletPlain "$STATE_DIR/ports.json")
WALLET_PORT_FULL=$(jq -r .walletFull "$STATE_DIR/ports.json")
case "$APP_PORT$WALLET_PORT_PLAIN$WALLET_PORT_FULL" in
  *null*) log "FATAL: $STATE_DIR/ports.json is not this runner's shape — start a fresh run"; exit 2 ;;
esac
APP_ORIGIN="http://127.0.0.1:$APP_PORT"
# One origin per profile: the SDK's discovery probe accepts any message from a wallet's ORIGIN, so
# same-origin profiles cross-talk and the slowest frame is never listed.
WALLET_ORIGIN_PLAIN="http://127.0.0.1:$WALLET_PORT_PLAIN"
WALLET_ORIGIN_FULL="http://127.0.0.1:$WALLET_PORT_FULL"
WEB_WALLETS="$WALLET_ORIGIN_PLAIN/?profile=plain,$WALLET_ORIGIN_FULL/?profile=full"

if [ -n "${PP_E2E_ATTACH:-}" ]; then attach_sandbox
elif [ "$MODE" = stack ]; then boot_stack
else boot_sandbox; fi
NODE_URL=$(jq -r .nodeUrl "$ARTIFACTS/handle.json")
STACK_MANIFEST=""
if [ "$MODE" = stack ]; then STACK_MANIFEST=$(jq -r .manifestPath "$STATE_DIR/stack.json"); fi
log "$MODE up — node $NODE_URL"

rebuild=0
if [ -z "${PP_E2E_ATTACH:-}" ] || [ "${PP_E2E_REBUILD:-}" = "1" ]; then rebuild=1; fi
if [ "$rebuild" = 1 ] || [ ! -d "$WALLET_DIST/assets" ]; then build_wallet; fi
if [ ! -f "$APP_DIR/package.json" ]; then
  log "no apps/web yet: the sandbox booted and the wallet bundled against it; nothing to drive"
  exit 0
fi
if [ "$rebuild" = 1 ] || [ ! -d "$APP_DIST/assets" ]; then build_app; else log "reusing the builds in $STATE_DIR"; fi

log "running playwright ($*)"
set +e
PP_E2E_MODE="$MODE" PP_SANDBOX_ARTIFACTS="$ARTIFACTS" PP_APP_PORT="$APP_PORT" PP_APP_DIST="$APP_DIST" \
PP_TEST_WALLET_PORT_PLAIN="$WALLET_PORT_PLAIN" PP_TEST_WALLET_PORT_FULL="$WALLET_PORT_FULL" \
PP_TEST_WALLET_DIST="$WALLET_DIST" PP_WEB_WALLETS="$WEB_WALLETS" PP_E2E_STATE_DIR="$STATE_DIR" \
NODE_OPTIONS="--import $KIT_DIR/node-json-imports.mjs ${NODE_OPTIONS:-}" \
  ./node_modules/.bin/playwright test --config playwright.config.ts "$@"
STATUS=$?
set -e
log "playwright exit $STATUS (state in $STATE_DIR)"
exit $STATUS
