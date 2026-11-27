import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { releasePorts, rowsOwnedBy } from "@pp/run-isolation/ports"
import { CleanupStack } from "@pp/run-isolation/process"
import { groupAlive } from "@pp/run-isolation/process-group"
import { ANVIL_CLIENT_VERSION, type ForkAnvil, startForkAnvil } from "./anvil.ts"
import { BUNDLE, bundleDir, readVkeys } from "./bundle.ts"
import { PINS, type Pins } from "./pins.ts"
import { checkEndpoint, checkFork, checkKeys, checkLive } from "./preflight.ts"
import { ENDPOINT_RETRIES, hostOf, httpRpc } from "./rpc.ts"
import { assertFork } from "./writer.ts"

export const RUNS_DIR = join(homedir(), ".cache/pp/fork/runs")

export type Leftovers = { groups: number; rows: number; dirs: number }

/** What a run started and has not taken down: its process group, its port rows, its data directory. */
export function leftovers(runId: string, dataDir: string, pgid: number | undefined): Leftovers {
	return {
		groups: pgid !== undefined && groupAlive(pgid) ? 1 : 0,
		rows: rowsOwnedBy(runId),
		dirs: existsSync(dataDir) ? 1 : 0,
	}
}

export const clean = (l: Leftovers) => l.groups + l.rows + l.dirs === 0

type RunOptions = {
	endpoint: string
	pins?: Pins
	runId?: string
	/** Runs on the live fork after the preflight, before teardown; `run.cleanup` unwinds with the fork's. */
	body?: (fork: ForkAnvil, run: RunContext) => Promise<void>
	log?: (line: string) => void
}

export type RunReport = { finalized: bigint; leftovers: Leftovers }

export type RunContext = { runId: string; dataDir: string; pins: Pins; cleanup: CleanupStack; log: (line: string) => void; bundle: string }

type Run = Omit<RunContext, "bundle"> & { pgid?: number }

async function preflightAndBody(o: RunOptions, run: Run): Promise<bigint> {
	const { pins, log } = run
	const host = hostOf(o.endpoint)
	const endpoint = httpRpc(o.endpoint, { retries: ENDPOINT_RETRIES })
	await checkEndpoint(endpoint, pins, host)
	log(`${host} serves block ${pins.block.number}`)
	const bundle = await bundleDir({ log })
	const t0 = performance.now()
	const fork = await startForkAnvil({
		endpoint: o.endpoint,
		block: pins.block.number,
		runId: run.runId,
		dataDir: run.dataDir,
		cleanup: run.cleanup,
		onSpawn: (pgid) => {
			run.pgid = pgid
		},
	})
	await assertFork(fork.rpc)
	log(`fork up in ${Math.round(performance.now() - t0)} ms (${ANVIL_CLIENT_VERSION})`)
	await checkFork(fork.rpc, pins)
	log(`every pin holds on the fork at block ${pins.block.number}`)
	await checkKeys(fork.rpc, pins, await readVkeys(bundle))
	log(`the pinned verifiers hold the ${BUNDLE} keys`)
	const finalized = await checkLive(endpoint, pins)
	log(`the live deployment matches the pins at finalized block ${finalized}`)
	await o.body?.(fork, { ...run, bundle })
	return finalized
}

/**
 * Checks the endpoint, forks it at the pinned block, checks the fork and the live deployment against
 * the pins, runs `body`, then tears down and counts what is left. Teardown and the count run on every
 * path, and on SIGINT and SIGTERM.
 * @throws PreflightError naming the failure's kind and pins; Error when teardown leaves anything behind
 */
export async function runFork(o: RunOptions): Promise<RunReport> {
	const runId = o.runId ?? `sepolia-fork-${process.pid}-${randomBytes(3).toString("hex")}`
	const run: Run = {
		runId,
		dataDir: join(RUNS_DIR, runId),
		pins: o.pins ?? PINS,
		cleanup: new CleanupStack(),
		log: o.log ?? ((line: string) => console.log(`sepolia-fork: ${line}`)),
	}
	mkdirSync(run.dataDir, { recursive: true, mode: 0o700 })
	run.cleanup.push(async () => rmSync(run.dataDir, { recursive: true, force: true }))
	run.cleanup.push(() => releasePorts(runId))
	let finalized: bigint | undefined
	let failure: unknown
	try {
		finalized = await preflightAndBody(o, run)
	} catch (err) {
		failure = err
	}
	await run.cleanup.run().catch((err: unknown) => {
		failure ??= err
	})
	const left = leftovers(runId, run.dataDir, run.pgid)
	run.log(`teardown: groups=${left.groups} rows=${left.rows} dirs=${left.dirs}`)
	if (failure !== undefined) throw failure
	if (!clean(left) || finalized === undefined)
		throw new Error(`teardown left groups=${left.groups} rows=${left.rows} dirs=${left.dirs} for run ${runId}`)
	return { finalized, leftovers: left }
}
