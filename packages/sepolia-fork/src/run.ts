import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { releasePorts, rowsOwnedBy } from "@pp/run-isolation/ports"
import { CleanupStack } from "@pp/run-isolation/process"
import { groupAlive } from "@pp/run-isolation/process-group"
import { ANVIL_CLIENT_VERSION, type ForkAnvil, startForkAnvil } from "./anvil.ts"
import { BUNDLE, bundleDir, readVkeys } from "./bundle.ts"
import { fixturePath } from "./forge.ts"
import { PINS, type Pins } from "./pins.ts"
import { checkEndpoint, checkFork, checkKeys, checkLive } from "./preflight.ts"
import { ENDPOINT_RETRIES, hostOf, httpRpc, type Rpc } from "./rpc.ts"
import { assertFork } from "./writer.ts"

export const RUNS_DIR = join(homedir(), ".cache/pp/fork/runs")
/** The whole run, preflight to teardown; past it the run fails and tears down whatever it started. */
export const RUN_DEADLINE_MS = 10 * 60_000
const SETTLE_MS = 5_000
const noop = () => {}

export type Leftovers = { groups: number; rows: number; dirs: number }

/** The owner pp-env's fork attach gives the mock ASP's port row for `runId`. */
const aspOwner = (runId: string) => `${runId}:pool`

/**
 * What a run started and has not taken down: its anvil's group, its port rows and the mock ASP's, its data and
 * fixture directories. Forge's groups are not counted: their teardown fails the run if one survives.
 */
export function leftovers(runId: string, dataDir: string, pgid: number | undefined): Leftovers {
	return {
		groups: pgid !== undefined && groupAlive(pgid) ? 1 : 0,
		rows: rowsOwnedBy(runId) + rowsOwnedBy(aspOwner(runId)),
		dirs: [dataDir, dirname(fixturePath(runId))].filter((d) => existsSync(d)).length,
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
	deadlineMs?: number
}

export type RunReport = { finalized: bigint; leftovers: Leftovers }

export type RunContext = {
	runId: string
	dataDir: string
	pins: Pins
	cleanup: CleanupStack
	log: (line: string) => void
	bundle: string
	/** Aborted at the deadline and when teardown starts; a step checks it before each side effect. */
	signal: AbortSignal
}

type Run = Omit<RunContext, "bundle"> & { pgid?: number }

async function preflightAndBody(o: RunOptions, run: Run): Promise<bigint> {
	const { pins, log } = run
	const host = hostOf(o.endpoint)
	const endpoint = httpRpc(o.endpoint, { retries: ENDPOINT_RETRIES, signal: run.signal })
	await checkEndpoint(endpoint, pins, host)
	log(`${host} serves block ${pins.block.number}`)
	run.signal.throwIfAborted()
	const bundle = await bundleDir({ log, cleanup: run.cleanup })
	run.signal.throwIfAborted()
	const t0 = performance.now()
	const fork = await startForkAnvil({
		endpoint: o.endpoint,
		block: pins.block.number,
		runId: run.runId,
		dataDir: run.dataDir,
		cleanup: run.cleanup,
		signal: run.signal,
		onSpawn: (pgid) => {
			run.pgid = pgid
		},
	})
	// Another listener on the claimed port could answer for the fork until its anvil exits; then the run ends.
	const lost = new Promise<never>((_, reject) => {
		void fork.owned.exited.then(() => reject(new Error(`the fork's anvil exited before teardown: ${fork.owned.exitReason()}`)))
	})
	lost.catch(() => {})
	return await Promise.race([onFork(o, run, fork, endpoint, bundle, t0), lost])
}

async function onFork(o: RunOptions, run: Run, fork: ForkAnvil, endpoint: Rpc, bundle: string, t0: number): Promise<bigint> {
	const { pins, log } = run
	await assertFork(fork.rpc)
	log(`fork up in ${Math.round(performance.now() - t0)} ms (${ANVIL_CLIENT_VERSION})`)
	await checkFork(fork.rpc, pins)
	log(`every pin holds on the fork at block ${pins.block.number}`)
	await checkKeys(fork.rpc, pins, await readVkeys(bundle))
	log(`the pinned verifiers hold the ${BUNDLE} keys`)
	const finalized = await checkLive(endpoint, pins)
	log(`the live deployment matches the pins at finalized block ${finalized}`)
	run.signal.throwIfAborted()
	await o.body?.(fork, { ...run, bundle })
	return finalized
}

/**
 * Checks the endpoint, forks it at the pinned block, checks the fork and the live deployment against
 * the pins, runs `body`, then tears down and counts what is left. Teardown runs on every path, SIGINT and
 * SIGTERM included; the count follows it on every path but a signal.
 * @throws PreflightError naming the failure's kind and pins; Error when teardown leaves anything behind
 */
export async function runFork(o: RunOptions): Promise<RunReport> {
	const runId = o.runId ?? `sepolia-fork-${process.pid}-${randomBytes(3).toString("hex")}`
	const abort = new AbortController()
	const run: Run = {
		runId,
		dataDir: join(RUNS_DIR, runId),
		pins: o.pins ?? PINS,
		cleanup: new CleanupStack(),
		log: o.log ?? ((line: string) => console.log(`sepolia-fork: ${line}`)),
		signal: abort.signal,
	}
	mkdirSync(run.dataDir, { recursive: true, mode: 0o700 })
	run.cleanup.push(async () => rmSync(run.dataDir, { recursive: true, force: true }))
	run.cleanup.push(() => releasePorts(runId))
	// pp-env's stop releases this row too, but a deadline can land between its claim and that stop's registration.
	run.cleanup.push(() => releasePorts(aspOwner(runId)))
	let finalized: bigint | undefined
	let failure: unknown
	const ms = o.deadlineMs ?? RUN_DEADLINE_MS
	let timer: ReturnType<typeof setTimeout> | undefined
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			const late = new Error(`the run passed its ${ms / 1000} s deadline`)
			abort.abort(late)
			reject(late)
		}, ms)
	})
	const work = preflightAndBody(o, run)
	// Past the deadline the work is abandoned to teardown, which kills the processes it is waiting on.
	work.catch(() => {})
	try {
		finalized = await Promise.race([work, expired])
	} catch (err) {
		failure = err
	} finally {
		clearTimeout(timer)
	}
	// Abandoned work stops at its next side effect rather than start one that teardown has already passed,
	// and gets a moment to get there, so a claim it had in flight commits before teardown releases it.
	abort.abort(new Error("the run is tearing down"))
	await Promise.race([work.then(noop, noop), Bun.sleep(SETTLE_MS)])
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
