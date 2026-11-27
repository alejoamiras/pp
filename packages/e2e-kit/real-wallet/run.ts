/**
 * `test:real-wallet`: one run of the suite on a state directory of its own, then a check that
 * nothing it owned survives. `agent.sh` uses a supplied state directory as is, so two runs given
 * one path would share ownership records; an incoming `PP_E2E_STATE_DIR` is therefore only the
 * parent of a fresh `mkdtemp` child. The exit status is the worse of the run's and the check's.
 *
 *   bun real-wallet/run.ts [-- <playwright args>]      (from packages/e2e-kit)
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { leftovers } from "./inventory"

const args = process.argv.slice(2).filter((a) => a !== "--")
// agent.sh reads a leading `reap` as its own command, which stops this checkout's other runs.
if (args[0] === "reap") {
	console.error("[real-wallet] `reap` is agent.sh's command, not a Playwright argument; run agent.sh reap directly")
	process.exit(2)
}

const kit = join(dirname(fileURLToPath(import.meta.url)), "..")
const parent = process.env.PP_E2E_STATE_DIR || join(kit, ".e2e-state")
mkdirSync(parent, { recursive: true })
const stateDir = mkdtempSync(join(parent, "real-wallet-"))

// A kept or attached run would outlive the leak check below.
const { PP_E2E_KEEP: _keep, PP_E2E_ATTACH: _attach, ...inherited } = process.env
const env: NodeJS.ProcessEnv = { ...inherited, PP_E2E_STATE_DIR: stateDir, PP_E2E_MODE: "stack", PP_E2E_WALLET: "real" }

const run = spawnSync("bash", [join(kit, "scripts/e2e/agent.sh"), ...args], { stdio: "inherit", env })
const status = run.status ?? 1
const left = leftovers(stateDir)
for (const line of left) console.error(`[real-wallet] left behind: ${line}`)
console.log(`[real-wallet] state in ${stateDir}; ${left.length === 0 ? "nothing of the run survives" : `${left.length} leftover(s)`}`)
process.exit(left.length > 0 ? Math.max(status, 1) : status)
