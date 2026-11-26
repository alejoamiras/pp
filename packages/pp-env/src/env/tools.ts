import { homedir } from "node:os"
import { join } from "node:path"

// Upstream code runs in subprocesses with only these variables: no agent sockets, tokens or ambient FOUNDRY_*.
const ENV_KEEP = ["PATH", "HOME", "LANG", "TMPDIR", "COREPACK_HOME"] as const

export function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {}
	for (const key of ENV_KEEP) {
		const value = process.env[key]
		if (value !== undefined) env[key] = value
	}
	return { ...env, ...extra }
}

/** The repository's single Foundry pin. */
export function forgeBin(): string {
	return process.env.PP_FORGE ?? join(homedir(), ".cache/pp/tools/foundry-1.7.1/forge")
}

export function anvilBin(): string {
	return process.env.PP_ANVIL ?? join(homedir(), ".aztec/versions/6.0.0/bin/aztec-anvil")
}

export type RunOptions = { cwd?: string; env?: Record<string, string> }

function tail(text: string, lines = 30): string {
	return text.trimEnd().split("\n").slice(-lines).join("\n")
}

/** Runs a command to completion; non-zero exit throws with the tail of its output. */
export async function run(cmd: string[], opts: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env ?? cleanEnv(), stdout: "pipe", stderr: "pipe", stdin: "ignore" })
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
	if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} exited ${code}\n${tail(stderr || stdout)}`)
	return { stdout, stderr }
}

export function forgeEnv(extra: Record<string, string> = {}): Record<string, string> {
	return cleanEnv({ FOUNDRY_PROFILE: "default", ...extra })
}

/**
 * Upstream's foundry.toml enables ffi, and Forge ignores FOUNDRY_FFI=false when the file sets it,
 * so the fetch patches the file and every forge call re-checks the effective value first.
 */
export async function assertFfiDisabled(contractsRoot: string): Promise<void> {
	const { stdout } = await run([forgeBin(), "config", "--json", "--root", contractsRoot], { env: forgeEnv() })
	const ffi = (JSON.parse(stdout) as { ffi?: unknown }).ffi
	if (ffi !== false)
		throw new Error(`forge reports ffi=${String(ffi)} for ${contractsRoot}; refusing to run upstream Solidity with shell access`)
}
