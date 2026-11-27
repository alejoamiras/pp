// Runs the Forge fork cases against the prepared anvil. Forge gets an environment built here, never the
// caller's: an ambient FOUNDRY_FFI, FOUNDRY_CONFIG or another profile would change what the cases may do.
import { closeSync, openSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { type CleanupStack, killGroup, type OwnedChild, own, spawnWatched } from "@pp/run-isolation/process"
import { resolveFoundry } from "./anvil.ts"

export const EVM_DIR = join(import.meta.dir, "../../../contracts/bridge/evm")
export const FORK_CASES = [
	"testFork_bridgeFromPool",
	"testFork_spendCannotChangeProcessor",
	"testFork_secretHashIsBound",
	"testFork_tamperedProofRejected",
] as const

export function forgeEnv(fixture: string): Record<string, string> {
	return { PATH: process.env.PATH ?? "", HOME: homedir(), FOUNDRY_PROFILE: "fork", PP_FORK_FIXTURE: fixture }
}

type Forge = { bin?: string; dataDir: string; cleanup: CleanupStack; env: Record<string, string> }

/**
 * Runs forge in a watched process group that dies with this process, stdout to a file read once it exits,
 * stderr appended to the run's log. `--root` stands in for a working directory, which a watched spawn lacks.
 */
async function forge(args: string[], o: Forge): Promise<string> {
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
	const stdout = readFileSync(outFile, "utf8")
	const reason = owned.exitReason()
	if (reason !== "exit code 0") throw Object.assign(new Error(`forge ${args[0]} ended with ${reason}`), { stdout })
	return stdout
}

type FsPermission = { access: string; path: string }

/** What Forge itself resolves for the fork profile: no ffi, and read access to `out/fork` alone. */
export function checkForkConfig(config: { ffi?: unknown; fs_permissions?: FsPermission[] }): void {
	if (config.ffi !== false) throw new Error(`the fork profile resolves ffi to ${JSON.stringify(config.ffi)}, not false`)
	const allowed = resolve(EVM_DIR, "out/fork")
	const perms = config.fs_permissions ?? []
	const wrong = perms.filter((p) => p.access !== "read" || resolve(EVM_DIR, p.path) !== allowed)
	if (perms.length !== 1 || wrong.length > 0)
		throw new Error(`the fork profile's fs_permissions are ${JSON.stringify(perms)}, not read-only ./out/fork`)
}

type TestResult = { status: string; reason?: string | null }
type SuiteResults = Record<string, { test_results: Record<string, TestResult> }>

/** Passes only when exactly the named cases ran and each passed; returns their count. */
export function checkForkResults(results: SuiteResults): number {
	const ran = Object.values(results).flatMap((s) => Object.entries(s.test_results))
	const byName = new Map(ran.map(([sig, r]) => [sig.replace(/\(.*$/, ""), r]))
	const failures = FORK_CASES.flatMap((name) => {
		const r = byName.get(name)
		if (!r) return [`${name} did not run`]
		return r.status === "Success" ? [] : [`${name}: ${r.status}${r.reason ? ` (${r.reason})` : ""}`]
	})
	const extra = [...byName.keys()].filter((n) => !(FORK_CASES as readonly string[]).includes(n))
	if (extra.length > 0) failures.push(`unexpected cases ran: ${extra.join(", ")}`)
	if (failures.length > 0) throw new Error(`fork cases failed: ${failures.join("; ")}`)
	return FORK_CASES.length
}

/** Checks the profile Forge resolves, then runs the named cases at `block` of the anvil at `url`. */
export async function runForkCases(o: Omit<Forge, "env"> & { url: string; block: number; fixture: string }): Promise<number> {
	const env = forgeEnv(o.fixture)
	checkForkConfig(JSON.parse(await forge(["config", "--json"], { ...o, env })))
	const args = ["test", "--match-contract", "Fork", "--fork-url", o.url, "--fork-block-number", String(o.block), "--json"]
	// A failing case exits non-zero and its report still names which and why; "No tests found" exits 0 with no report.
	const { stdout, failure } = await forge(args, { ...o, env }).then(
		(stdout) => ({ stdout, failure: "forge test printed no report" }),
		(err: Error & { stdout?: string }) => ({ stdout: err.stdout ?? "", failure: err.message }),
	)
	if (!stdout.trim().startsWith("{")) {
		const log = readFileSync(join(o.dataDir, "forge.log"), "utf8")
		const said = `${stdout}\n${log}`.trim().split("\n").filter(Boolean).slice(-3).join(" | ")
		throw new Error(`${failure}: ${said}`)
	}
	return checkForkResults(JSON.parse(stdout))
}
