/**
 * Rehearsal part `pause`: the guardian's failure and recovery cases and `deploy`'s stale-build refusal,
 * each on a bare local anvil of its own, all at once. The part takes as long as its longest case, the
 * CLI's 30-minute finality budget. Needs `contracts/bridge/evm/out` at the committed build.
 */
import { mkdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { releasePorts, rowsOwnedBy } from "@pp/run-isolation/ports"
import { CleanupStack } from "@pp/run-isolation/process"
import { buildMismatch } from "../creation"
import { finalityTimeout, nonceGap, occupiedNonce, pendingOpenResend, stalledPause } from "./pause-cases"
import type { CaseCtx } from "./pause-stage"
import { staleBuild } from "./stale-build"

const CASES: Record<string, (c: CaseCtx) => Promise<string[]>> = {
	"pending-open": pendingOpenResend,
	"nonce-gap": nonceGap,
	"nonce-occupied": occupiedNonce,
	"finality-timeout": finalityTimeout,
	"stale-build": staleBuild,
	stalled: stalledPause,
}

export type CaseResult = { case: string; ms: number; outcome: string[] }

type Part = { runId: string; dir: string; log: (line: string) => void }

async function runCase(p: Part, name: string, body: (c: CaseCtx) => Promise<string[]>): Promise<CaseResult> {
	const dir = join(p.dir, name)
	mkdirSync(dir, { recursive: true, mode: 0o700 })
	const cleanup = new CleanupStack()
	const t0 = performance.now()
	const log = (line: string) => p.log(`[pause:${name}] ${line}`)
	try {
		const outcome = await body({ name, runId: p.runId, dir, cleanup, log })
		const ms = Math.round(performance.now() - t0)
		for (const line of outcome) log(line)
		log(`passed in ${Math.round(ms / 1000)} s`)
		return { case: name, ms, outcome }
	} catch (e) {
		log(`failed: ${e instanceof Error ? e.message : String(e)}`)
		throw e
	} finally {
		await cleanup.run()
	}
}

export async function pauseRehearsal(log: (line: string) => void): Promise<{ cases: CaseResult[] }> {
	const mismatch = buildMismatch()
	if (mismatch)
		throw new Error(`contracts/bridge/evm/out is not the committed build (${mismatch}); the factory and the stale-build case need it`)
	const runId = `pp-testnet-rehearse-pause-${process.pid}`
	const dir = join(homedir(), ".cache", "pp", "testnet", "rehearse", runId)
	mkdirSync(dir, { recursive: true, mode: 0o700 })
	const p: Part = { runId, dir, log }
	// The proxies' and node stubs' rows have no watcher to release them if a signal ends this process.
	const rows = new CleanupStack()
	rows.push(() => releasePorts(runId))
	try {
		log(`[pause] ${Object.keys(CASES).length} cases at once, each on its own anvil`)
		const settled = await Promise.allSettled(Object.entries(CASES).map(([name, body]) => runCase(p, name, body)))
		const failed = settled.flatMap((s, i) => (s.status === "rejected" ? [Object.keys(CASES)[i]] : []))
		if (failed.length) throw new Error(`cases failed: ${failed.join(", ")}`)
		await releasePorts(runId)
		if (rowsOwnedBy(runId) !== 0) throw new Error(`${runId} still holds port rows`)
		rmSync(dir, { recursive: true, force: true })
		return { cases: settled.map((s) => (s as PromiseFulfilledResult<CaseResult>).value) }
	} catch (e) {
		log(`[pause] failed; its logs and files stay in ${dir}`)
		throw e
	} finally {
		await rows.run()
	}
}
