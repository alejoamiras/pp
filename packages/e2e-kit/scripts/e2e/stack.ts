/**
 * The local stack under a stack-mode run. `up` starts local-stack's CLI with `--keep` as a process
 * group of its own, logging to `<state>/stack.log`, and returns once the stack is ready, having
 * written `<state>/stack.json` (the group, the manifest, the seeded accounts' anvil indices) and
 * `<state>/wallet/handle.json` (the three fields the test wallet build reads). `down` ends that group
 * only while it is still the one this state dir started. SIGTERM makes the CLI tear down every group
 * it started itself, so the grace is long: SIGKILL would orphan them and is the last resort.
 *
 *   bun scripts/e2e/stack.ts up <state-dir>     bun scripts/e2e/stack.ts down <state-dir>
 */
import { spawn } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { parseStackManifest, type StackManifest } from "@pp/bridge-core/stack-manifest"
import { ANVIL_ACCOUNTS, anvilKey } from "@pp/bridge-core/sandbox"
import { endGroup, groupAlive, groupMembers } from "@pp/run-isolation/process-group"
import { getAddress } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { type StackRun, stackRun, stackRunFile } from "../../env"

const CLI = join(dirname(fileURLToPath(import.meta.resolve("@pp/local-stack"))), "cli.ts")
const READY_MS = 20 * 60_000
/** Longer than the CLI's slowest teardown; its boot steps also finish before a signal takes effect. */
const STOP_GRACE_MS = 180_000
const LOCAL_CHAIN_ID = 31337

const files = (stateDir: string) => ({
	log: join(stateDir, "stack.log"),
	pid: join(stateDir, "stack.pid"),
	run: stackRunFile({ stateDir }),
	walletHandle: join(stateDir, "wallet", "handle.json"),
})

const READY = /PP_STACK_MANIFEST=(\S+)/
const SEEDED = /pool user (0x[0-9a-fA-F]{40})\b.*bridge sender (0x[0-9a-fA-F]{40})\b/

function anvilIndexOf(address: string): number {
	for (let i = 0; i < ANVIL_ACCOUNTS; i++) if (privateKeyToAccount(anvilKey(i)).address === getAddress(address)) return i
	throw new Error(`stack: ${address} is none of anvil's first ${ANVIL_ACCOUNTS} accounts`)
}

/** Resolves with the manifest path and seeded line once both are logged; rejects if the CLI exits first. */
async function untilReady(log: string, exited: () => number | null): Promise<{ manifestPath: string; seeded: RegExpMatchArray }> {
	for (const end = Date.now() + READY_MS; Date.now() < end; await sleep(1_000)) {
		const text = existsSync(log) ? readFileSync(log, "utf8") : ""
		const ready = text.match(READY)
		const seeded = text.match(SEEDED)
		if (ready?.[1] && seeded) return { manifestPath: ready[1], seeded }
		const code = exited()
		if (code !== null) throw new Error(`stack: the CLI exited (${code}) before it was ready; see ${log}`)
	}
	throw new Error(`stack: not ready within ${READY_MS / 60_000} min; see ${log}`)
}

async function nodeInfo(nodeUrl: string): Promise<{ l1ChainId: number; rollupVersion: number }> {
	const res = await fetch(nodeUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "node_getNodeInfo", params: [] }),
		signal: AbortSignal.timeout(10_000),
	})
	const { result } = (await res.json()) as { result?: { l1ChainId?: unknown; rollupVersion?: unknown } }
	const l1ChainId = Number(result?.l1ChainId)
	const rollupVersion = Number(result?.rollupVersion)
	if (!Number.isSafeInteger(l1ChainId) || !Number.isSafeInteger(rollupVersion)) throw new Error(`stack: ${nodeUrl} gave no node info`)
	return { l1ChainId, rollupVersion }
}

/** The manifest, checked to be a loopback stack whose node serves its L1 chain. */
async function checkedManifest(path: string): Promise<{ manifest: StackManifest; rollupVersion: number }> {
	const manifest = parseStackManifest(JSON.parse(readFileSync(path, "utf8")))
	if (manifest.chainId !== LOCAL_CHAIN_ID)
		throw new Error(`stack: the manifest names chain ${manifest.chainId}, expected ${LOCAL_CHAIN_ID}`)
	const info = await nodeInfo(manifest.aztecNode)
	if (info.l1ChainId !== manifest.chainId) throw new Error(`stack: the node serves L1 chain ${info.l1ChainId}, not ${manifest.chainId}`)
	return { manifest, rollupVersion: info.rollupVersion }
}

async function up(stateDir: string): Promise<void> {
	const f = files(stateDir)
	mkdirSync(dirname(f.walletHandle), { recursive: true })
	const out = openSync(f.log, "w")
	const child = spawn(process.execPath, [CLI, "demo", "--keep"], { detached: true, stdio: ["ignore", out, out] })
	closeSync(out)
	const pgid = child.pid
	if (pgid === undefined) throw new Error("stack: the CLI did not start")
	writeFileSync(f.pid, `${pgid}\n`)
	let code: number | null = null
	child.once("exit", (c, signal) => {
		code = c ?? (signal ? 128 : 1)
	})
	try {
		const { manifestPath, seeded } = await untilReady(f.log, () => code)
		const { manifest, rollupVersion } = await checkedManifest(manifestPath)
		const account = (address: string) => ({ address: getAddress(address), index: anvilIndexOf(address) })
		const run: StackRun = { pgid, manifestPath, accounts: { user: account(seeded[1] ?? ""), sender: account(seeded[2] ?? "") } }
		writeFileSync(f.walletHandle, JSON.stringify({ nodeUrl: manifest.aztecNode, l1ChainId: manifest.chainId, rollupVersion }))
		writeFileSync(f.run, JSON.stringify(run, null, 2))
	} catch (err) {
		await endGroup(pgid, STOP_GRACE_MS)
		rmSync(f.pid, { force: true })
		throw err
	}
	child.unref()
	console.log(`[e2e] stack up (pgid ${pgid}) — PP_STACK_MANIFEST=${stackRun({ stateDir }).manifestPath}`)
}

/** Whether `pgid` still leads the CLI this state dir started: its command and the pid the CLI logged. */
function ownedBy(stateDir: string, pgid: number): boolean {
	const leader = groupMembers(pgid).find((m) => m.pid === pgid)
	const f = files(stateDir)
	const logged = existsSync(f.log) ? readFileSync(f.log, "utf8").match(/^\[stack\] run \S+ pid (\d+)$/m)?.[1] : undefined
	return groupAlive(pgid) && leader?.args.includes(CLI) === true && logged === String(pgid)
}

async function down(stateDir: string): Promise<void> {
	const f = files(stateDir)
	if (!existsSync(f.pid)) return console.log("[e2e] no stack to stop")
	const pgid = Number(readFileSync(f.pid, "utf8").trim())
	if (Number.isSafeInteger(pgid) && pgid > 1 && ownedBy(stateDir, pgid)) {
		console.log(`[e2e] stopping the stack (pgid ${pgid})`)
		if (!(await endGroup(pgid, STOP_GRACE_MS))) throw new Error(`stack: pgid ${pgid} survived SIGKILL`)
	} else console.log(`[e2e] the stack this state dir started is gone (pgid ${pgid})`)
	rmSync(f.pid, { force: true })
}

const [command, stateDir] = process.argv.slice(2)
if ((command !== "up" && command !== "down") || !stateDir) throw new Error("usage: bun scripts/e2e/stack.ts up|down <state-dir>")
await (command === "up" ? up(stateDir) : down(stateDir))
