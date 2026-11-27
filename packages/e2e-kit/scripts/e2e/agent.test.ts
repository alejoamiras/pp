import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

const AGENT = new URL("./agent.sh", import.meta.url).pathname

/** Stands in for `bun`: records each call, and touches only the state dir the test owns. */
const FAKE_BUN = `#!/bin/sh
echo "$*" >> "$FAKE_CALLS"
case "$1:$2" in
  scripts/e2e/resolve-ports.ts:--release) ;;
  scripts/e2e/resolve-ports.ts:*)
    [ "$2" = "$FAKE_OWN" ] && printf '{"app":11,"walletPlain":12,"walletFull":13,"owner":"t"}\\n' > "$2/ports.json" ;;
  scripts/e2e/stack.ts:up)
    [ "$3" = "$FAKE_OWN" ] || exit 1
    echo "boot failed" > "$3/stack.log"
    if [ -n "$FAKE_LEFT" ]; then echo "$FAKE_LEFT" > "$3/stack.pid"; fi
    exit 1 ;;
esac
exit 0
`

/** Runs the stack-mode runner over a boot that fails; `left` is the record `up` could not clear. */
function failedBoot(o: { keep: boolean; left?: string }) {
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

	test("keeps its ports claimed while stack.pid still names a stack", () => {
		const r = failedBoot({ keep: false, left: "4242 1 ns" })
		expect(r.status).toBe(2)
		expect(r.calls).toContain(`scripts/e2e/stack.ts down ${r.state}`)
		expect(r.calls.filter((c) => c.includes("--release"))).toEqual([])
		expect(r.out).toContain("stack.pid still names a stack")
	})
})
