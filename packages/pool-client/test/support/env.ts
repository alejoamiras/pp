// `pp-env up` as a subprocess in its own process group: pp-env needs Bun, and this suite also runs on Node.
import { type ChildProcess, spawn } from "node:child_process"
import { join } from "node:path"
import type { Address } from "viem"
import type { PoolConfig } from "../../src/types.ts"
import { PACKAGE_DIR } from "./paths.ts"

const PP_ENV_DIR = join(PACKAGE_DIR, "../pp-env")
const READY_MS = 180_000
const STOP_MS = 60_000

/** The fields of the CLI's JSON this suite uses. */
export type UpEnv = {
	runId: string
	rpcUrl: string
	chainId: number
	deployment: { pool: Address; entrypoint: Address; keystore: Address; aspRegistry: Address; deployBlock: string }
	asset: Address
	aspUrl: string
}

export function poolConfig(e: UpEnv): PoolConfig {
	const d = e.deployment
	return {
		chainId: e.chainId,
		l1Rpc: e.rpcUrl,
		poolVault: d.pool,
		entrypoint: d.entrypoint,
		aspRegistry: d.aspRegistry,
		keystore: d.keystore,
		asset: e.asset,
		deployBlock: BigInt(d.deployBlock),
		aspApiUrl: e.aspUrl,
	}
}

function parseEnv(stdout: string): UpEnv | undefined {
	try {
		const e = JSON.parse(stdout) as UpEnv
		return e.runId && e.rpcUrl && e.deployment?.pool && e.asset && e.aspUrl ? e : undefined
	} catch {
		return undefined
	}
}

export type RunningEnv = { env: UpEnv; stop(): Promise<void> }

async function stopGroup(child: ChildProcess, runId: string): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
	process.kill(-child.pid!, "SIGTERM")
	const timer = new Promise<"late">((resolve) => setTimeout(() => resolve("late"), STOP_MS).unref())
	if ((await Promise.race([exited, timer])) === "late")
		throw new Error(`pp-env run ${runId ?? "(no id)"} (pgid ${child.pid}) did not stop within ${STOP_MS} ms; reap it by that pgid`)
}

/** Resolves once stderr has printed the ready line and stdout holds the whole JSON document, in either order. */
export async function startEnv(): Promise<RunningEnv> {
	const child = spawn("bun", ["src/cli.ts", "up"], { cwd: PP_ENV_DIR, detached: true, stdio: ["ignore", "pipe", "pipe"] })
	let stdout = ""
	let stderr = ""
	let env: UpEnv | undefined
	const ready = new Promise<UpEnv>((resolve, reject) => {
		const check = () => {
			env ??= parseEnv(stdout)
			if (env && stderr.includes("[pp-env] up")) resolve(env)
		}
		child.stdout!.on("data", (b: Buffer) => {
			stdout += b.toString()
			check()
		})
		child.stderr!.on("data", (b: Buffer) => {
			stderr += b.toString()
			check()
		})
		child.once("exit", (code, signal) =>
			reject(new Error(`pp-env up exited (${code ?? signal}) before it was ready:\n${stderr.slice(-2000)}`)),
		)
		setTimeout(() => reject(new Error(`pp-env up was not ready within ${READY_MS} ms:\n${stderr.slice(-2000)}`)), READY_MS).unref()
	})
	try {
		const up = await ready
		return { env: up, stop: () => stopGroup(child, up.runId) }
	} catch (err) {
		await stopGroup(child, env?.runId ?? "")
		throw err
	}
}
