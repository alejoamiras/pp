import { spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const AGENT = fileURLToPath(new URL("./agent.sh", import.meta.url))

/** Stands in for `bun`: records each call, and touches only the state dir the test owns. */
const FAKE_BUN = `#!/bin/sh
echo "$*" >> "$FAKE_CALLS"
case "$1:$2" in
  scripts/e2e/resolve-ports.ts:--release) exit "\${FAKE_RELEASE:-0}" ;;
  scripts/e2e/resolve-ports.ts:*)
    [ "$2" = "$FAKE_OWN" ] && printf '{"app":11,"walletPlain":12,"walletFull":13,"owner":"t"}\\n' > "$2/ports.json" ;;
  scripts/e2e/stack.ts:down) exit "\${FAKE_DOWN:-0}" ;;
  run:build:test-wallet)
    mkdir -p "$PP_TEST_WALLET_OUT_DIR/assets" && echo "http://127.0.0.1:1" > "$PP_TEST_WALLET_OUT_DIR/assets/w.js" ;;
  scripts/e2e/stack.ts:up)
    [ "$3" = "$FAKE_OWN" ] || exit 1
    if [ -n "$FAKE_UP" ]; then
      mkdir -p "$3/wallet"
      echo '{"nodeUrl":"http://127.0.0.1:1"}' > "$3/wallet/handle.json"
      echo '{"manifestPath":"/m.json"}' > "$3/stack.json"
      exit 0
    fi
    echo "boot failed" > "$3/stack.log"
    if [ -n "$FAKE_LEFT" ]; then echo "$FAKE_LEFT" > "$3/stack.pid"; fi
    # Ctrl-C reaches the whole foreground group: the runner, and this boot, which dies of it.
    if [ -n "$FAKE_INTERRUPT" ]; then kill -INT "$PPID"; kill -INT $$; fi
    exit 1 ;;
esac
exit 0
`

/**
 * Runs the stack-mode runner over a boot that fails, or that Ctrl-C interrupts; `left` is the record
 * `up` could not clear.
 */
function failedBoot(o: { keep: boolean; left?: string; interrupt?: boolean }) {
	const base = join(homedir(), ".cache", "pp", "e2e-kit")
	mkdirSync(base, { recursive: true })
	const root = mkdtempSync(join(base, "agent-"))
	const bin = join(root, "bin")
	const state = join(root, "state")
	mkdirSync(bin)
	mkdirSync(state)
	writeFileSync(join(bin, "bun"), FAKE_BUN)
	chmodSync(join(bin, "bun"), 0o755)
	const calls = join(root, "calls")
	const { PP_E2E_ATTACH: _a, PP_E2E_KEEP: _k, ...env } = process.env
	const run = spawnSync("bash", [AGENT], {
		encoding: "utf8",
		env: {
			...env,
			PATH: `${bin}:${env.PATH ?? ""}`,
			PP_E2E_MODE: "stack",
			PP_E2E_STATE_DIR: state,
			...(o.keep ? { PP_E2E_KEEP: "1" } : {}),
			FAKE_CALLS: calls,
			FAKE_OWN: state,
			FAKE_LEFT: o.left ?? "",
			FAKE_INTERRUPT: o.interrupt ? "1" : "",
		},
	})
	const made = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []
	rmSync(root, { recursive: true, force: true })
	return { status: run.status, out: run.stdout + run.stderr, calls: made, state }
}

describe("a stack that failed to boot", () => {
	test("is not kept under PP_E2E_KEEP=1: the runner stops what is left and returns the ports", () => {
		const r = failedBoot({ keep: true })
		expect(r.status).toBe(2)
		expect(r.out).not.toContain("stack kept")
		expect(r.calls).toContain(`scripts/e2e/stack.ts down ${r.state}`)
		expect(r.calls).toContain(`scripts/e2e/resolve-ports.ts --release ${r.state}`)
	})

	test("is not kept under PP_E2E_KEEP=1 when Ctrl-C interrupts the boot", () => {
		const r = failedBoot({ keep: true, interrupt: true })
		expect(r.out).not.toContain("stack kept")
		expect(r.calls).toContain(`scripts/e2e/stack.ts down ${r.state}`)
		expect(r.calls).toContain(`scripts/e2e/resolve-ports.ts --release ${r.state}`)
	})

	test("keeps its ports claimed while stack.pid still names a stack", () => {
		const r = failedBoot({ keep: false, left: "4242 1 ns" })
		expect(r.status).toBe(2)
		expect(r.calls).toContain(`scripts/e2e/stack.ts down ${r.state}`)
		expect(r.calls.filter((c) => c.includes("--release"))).toEqual([])
		expect(r.out).toContain("stack.pid still names a stack")
	})
})

/**
 * Runs a copy of the runner in a checkout with no `apps/web`, so a stack that boots ends the run with
 * status 0 after the wallet build; `down` and the port release exit with the codes given. `reap`
 * runs the runner's own `reap` command over one stack state left in that checkout instead.
 */
function passedRun(o: { down: number; release: number; reap?: boolean }) {
	const base = join(homedir(), ".cache", "pp", "e2e-kit")
	mkdirSync(base, { recursive: true })
	const root = mkdtempSync(join(base, "agent-"))
	const kit = join(root, "repo", "packages", "e2e-kit")
	const bin = join(root, "bin")
	const state = join(kit, ".e2e-state", "left")
	mkdirSync(join(kit, "scripts", "e2e"), { recursive: true })
	mkdirSync(bin)
	mkdirSync(state, { recursive: true })
	copyFileSync(AGENT, join(kit, "scripts", "e2e", "agent.sh"))
	writeFileSync(join(bin, "bun"), FAKE_BUN)
	chmodSync(join(bin, "bun"), 0o755)
	if (o.reap) {
		writeFileSync(join(state, "stack.pid"), "4242 1 ns\n")
		writeFileSync(join(state, "ports.json"), "{}\n")
	}
	const calls = join(root, "calls")
	const { PP_E2E_ATTACH: _a, PP_E2E_KEEP: _k, PP_E2E_STATE_DIR: _s, ...env } = process.env
	const run = spawnSync("bash", [join(kit, "scripts", "e2e", "agent.sh"), ...(o.reap ? ["reap"] : [])], {
		encoding: "utf8",
		env: {
			...env,
			PATH: `${bin}:${env.PATH ?? ""}`,
			PP_E2E_MODE: "stack",
			...(o.reap ? {} : { PP_E2E_STATE_DIR: state }),
			FAKE_CALLS: calls,
			FAKE_OWN: state,
			FAKE_UP: "1",
			FAKE_DOWN: String(o.down),
			FAKE_RELEASE: String(o.release),
		},
	})
	const made = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : []
	rmSync(root, { recursive: true, force: true })
	return { status: run.status, out: run.stdout + run.stderr, calls: made, state }
}

describe("a run whose tests passed", () => {
	test("exits 0 when the stack stops and the ports go back", () => {
		const r = passedRun({ down: 0, release: 0 })
		expect(r.status, r.out).toBe(0)
		expect(r.calls).toContain(`scripts/e2e/stack.ts down ${r.state}`)
		expect(r.calls).toContain(`scripts/e2e/resolve-ports.ts --release ${r.state}`)
	})

	test("fails when the stack does not stop cleanly, and still returns the ports", () => {
		const r = passedRun({ down: 1, release: 0 })
		expect(r.status, r.out).toBe(1)
		expect(r.out).toContain("the run passed, but its teardown failed")
		expect(r.calls).toContain(`scripts/e2e/resolve-ports.ts --release ${r.state}`)
	})

	test("fails when its ports are not released", () => {
		const r = passedRun({ down: 0, release: 1 })
		expect(r.status, r.out).toBe(1)
		expect(r.out).toContain("were not released")
	})
})

test("reap fails when a stack it finds does not stop cleanly", () => {
	const r = passedRun({ down: 1, release: 0, reap: true })
	expect(r.status, r.out).toBe(1)
	expect(r.calls).toContain(`scripts/e2e/stack.ts down ${r.state}`)
})
