// Runs the Forge fork cases against the prepared anvil. Forge gets an environment built here, never the
// caller's: an ambient FOUNDRY_FFI, FOUNDRY_CONFIG or another profile would change what the cases may do.
import { closeSync, openSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { type CleanupStack, killGroup, type OwnedChild, own, spawnWatched } from "@pp/run-isolation/process"
import { resolveFoundry } from "./anvil.ts"

export const EVM_DIR = join(import.meta.dir, "../../../contracts/bridge/evm")
/** A run's fixture, under the one directory the fork profile lets Forge read. */
export const fixturePath = (runId: string) => join(EVM_DIR, "out/fork", runId, "fixture.json")
const SUITE_FILE = "test/PortalFork.t.sol"
const SUITE = `${SUITE_FILE}:PortalForkTest`
export const FORK_CASES = [
	"testFork_bridgeFromPool",
	"testFork_spendCannotChangeProcessor",
	"testFork_secretHashIsBound",
	"testFork_tamperedProofRejected",
] as const

export function forgeEnv(fixture: string): Record<string, string> {
	return { PATH: process.env.PATH ?? "", HOME: homedir(), FOUNDRY_PROFILE: "fork", PP_FORK_FIXTURE: fixture }
}

type Forge = { bin?: string; dataDir: string; cleanup: CleanupStack; env: Record<string, string>; signal?: AbortSignal }
type Ran = { stdout: string; exit: string | undefined }

/**
 * Runs forge in a watched process group that dies with this process, stdout to a file read once it exits,
 * stderr appended to the run's log. `--root` stands in for a working directory, which a watched spawn lacks.
 */
async function forge(args: string[], o: Forge): Promise<Ran> {
	o.signal?.throwIfAborted()
	const outFile = join(o.dataDir, `forge-${args[0]}.out`)
	const out = openSync(outFile, "w", 0o600)
	const log = openSync(join(o.dataDir, "forge.log"), "a", 0o600)
	let owned: OwnedChild
	try {
		const child = spawnWatched(o.bin ?? resolveFoundry("forge"), [...args, "--root", EVM_DIR], {
			stdio: ["ignore", out, log],
			env: o.env,
		})
		owned = own(child)
	} finally {
		closeSync(out)
		closeSync(log)
	}
	o.cleanup.push(async () => {
		if (!(await killGroup(owned))) throw new Error(`forge's process group ${owned.child.pid} survived SIGKILL`)
	})
	await owned.exited
	return { stdout: readFileSync(outFile, "utf8"), exit: owned.exitReason() }
}

const OK = "exit code 0"

/** Forge's last lines across stdout and its log, for a failure that has no report to name. */
function said(stdout: string, dataDir: string): string {
	const log = readFileSync(join(dataDir, "forge.log"), "utf8")
	return `${stdout}\n${log}`.trim().split("\n").filter(Boolean).slice(-3).join(" | ")
}

type FsPermission = { access: string; path: string }

/** What Forge itself resolves for the fork profile: no ffi, no RPC storage cache, and read access to `out/fork` alone. */
export function checkForkConfig(config: { ffi?: unknown; no_storage_caching?: unknown; fs_permissions?: FsPermission[] }): void {
	if (config.ffi !== false) throw new Error(`the fork profile resolves ffi to ${JSON.stringify(config.ffi)}, not false`)
	if (config.no_storage_caching !== true)
		throw new Error(`the fork profile resolves no_storage_caching to ${JSON.stringify(config.no_storage_caching)}, not true`)
	const allowed = resolve(EVM_DIR, "out/fork")
	const perms = config.fs_permissions ?? []
	const wrong = perms.filter((p) => p.access !== "read" || resolve(EVM_DIR, p.path) !== allowed)
	if (perms.length !== 1 || wrong.length > 0)
		throw new Error(`the fork profile's fs_permissions are ${JSON.stringify(perms)}, not read-only ./out/fork`)
}

type TestResult = { status: string; reason?: string | null }
type SuiteResults = Record<string, { test_results: Record<string, TestResult> }>

const verdict = (sig: string, r: TestResult) => `${sig}: ${r.status}${r.reason ? ` (${r.reason})` : ""}`

/** Passes only when PortalForkTest alone ran exactly the named cases and each passed; returns their count. */
export function checkForkResults(results: SuiteResults): number {
	const suites = Object.keys(results)
	if (suites.length !== 1 || suites[0] !== SUITE) throw new Error(`forge ran ${JSON.stringify(suites)}, not ${SUITE} alone`)
	const ran = results[SUITE]?.test_results ?? {}
	const wanted = FORK_CASES.map((name) => `${name}()`)
	const failures = wanted.flatMap((sig) => {
		const r = ran[sig]
		if (!r) return [`${sig} did not run`]
		return r.status === "Success" ? [] : [verdict(sig, r)]
	})
	// setUp's failure lands here too, with its reason.
	const extra = Object.entries(ran).filter(([sig]) => !wanted.includes(sig))
	if (extra.length > 0) failures.push(`unexpected entries: ${extra.map(([sig, r]) => verdict(sig, r)).join(", ")}`)
	if (failures.length > 0) throw new Error(`fork cases failed: ${failures.join("; ")}`)
	return FORK_CASES.length
}

/** Checks the profile Forge resolves, then runs the named cases at `block` of the anvil at `url`. */
export async function runForkCases(o: Omit<Forge, "env"> & { url: string; block: number; fixture: string }): Promise<number> {
	const env = forgeEnv(o.fixture)
	const config = await forge(["config", "--json"], { ...o, env })
	if (config.exit !== OK) throw new Error(`forge config ended with ${config.exit}: ${said(config.stdout, o.dataDir)}`)
	checkForkConfig(JSON.parse(config.stdout))
	const match = ["--match-path", SUITE_FILE, "--match-contract", "^PortalForkTest$"]
	const test = await forge(["test", ...match, "--fork-url", o.url, "--fork-block-number", String(o.block), "--json"], { ...o, env })
	// A failing case exits non-zero with a report naming which and why; "No tests found" exits 0 with none.
	if (!test.stdout.trim().startsWith("{"))
		throw new Error(`forge test ${test.exit === OK ? "printed no report" : `ended with ${test.exit}`}: ${said(test.stdout, o.dataDir)}`)
	const passed = checkForkResults(JSON.parse(test.stdout))
	if (test.exit !== OK) throw new Error(`forge test ended with ${test.exit} after a passing report`)
	return passed
}
