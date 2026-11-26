import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export const REPO = fileURLToPath(new URL("../../..", import.meta.url))
export const AZTEC_DIR = join(REPO, "contracts", "bridge", "aztec")
const NARGO_SH = join(AZTEC_DIR, "scripts", "nargo.sh")

export type NargoTest = { name: string; event: string; message: string }
export type NargoRun = { tests: NargoTest[]; passed: number; failed: number; error?: string }

type NargoEvent = { type?: string; event?: string; name?: string; passed?: number; failed?: number; stdout?: string; message?: string }

/**
 * `nargo test --force --format json [filter]` in `crateDir` through the pinned wrapper; test names
 * lose their module path. A filter that matches nothing still exits 0, so callers check the names.
 */
export function nargoTest(crateDir: string, opts: { filter?: string; timeoutMs?: number } = {}): NargoRun {
	const args = [NARGO_SH, crateDir, "test", "--force", "--format", "json", ...(opts.filter ? [opts.filter] : [])]
	const proc = spawnSync("bash", args, {
		encoding: "utf8",
		timeout: opts.timeoutMs ?? 900_000,
		maxBuffer: 64 * 1024 * 1024,
	})
	if (proc.error || proc.signal) return { tests: [], passed: 0, failed: 0, error: `nargo did not finish: ${proc.error ?? proc.signal}` }
	const events = proc.stdout.split("\n").flatMap((line): NargoEvent[] => {
		try {
			return line.startsWith("{") ? [JSON.parse(line)] : []
		} catch {
			return []
		}
	})
	const suite = events.find((e) => e.type === "suite" && e.event !== "started")
	const tests = events
		.filter((e) => e.type === "test" && e.event !== "started")
		.map((e) => ({ name: (e.name ?? "").replace(/^.*::/, ""), event: e.event ?? "", message: `${e.stdout ?? ""}${e.message ?? ""}` }))
	if (suite === undefined)
		return { tests, passed: 0, failed: 0, error: `no suite result:\n${proc.stdout.slice(-3000)}\n${proc.stderr.slice(-3000)}` }
	return { tests, passed: suite.passed ?? 0, failed: suite.failed ?? 0 }
}
