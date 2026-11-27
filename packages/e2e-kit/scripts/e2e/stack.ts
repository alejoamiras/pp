/**
 * The local stack under a stack-mode run. `up` starts local-stack's CLI with `--keep` as a process
 * group of its own, logging to `<state>/stack.log`, and returns once the stack is ready, having
 * written `<state>/stack.json` (the group, the manifest, the seeded accounts' anvil indices) and
 * `<state>/wallet/handle.json` (the three fields the test wallet build reads). `down` ends that group
 * only while it is still the one this state dir started, which `<state>/stack.pid` records from the
 * moment of the spawn (`scripts/e2e/stack-owner.ts`). SIGTERM lets the CLI tear down every group it
 * started in order, so the grace is long; SIGKILL is the last resort, and those groups still end with the CLI.
 *
 *   bun scripts/e2e/stack.ts up <state-dir>     bun scripts/e2e/stack.ts down <state-dir>
 */
import { spawn } from "node:child_process"
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseStackManifest, type StackManifest } from "@pp/bridge-core/stack-manifest"
import { ANVIL_ACCOUNTS, anvilKey } from "@pp/bridge-core/sandbox"
import { getAddress } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { type StackRun, stackRun, stackRunFile } from "../../env"
import { untilReady } from "./stack-log"
import { abandonBoot, recordGroup, stopRecorded } from "./stack-owner"

const CLI = fileURLToPath(import.meta.resolve("@pp/local-stack/cli"))
/** Longer than the CLI's slowest teardown; its boot steps also finish before a signal takes effect. */
const STOP_GRACE_MS = 180_000
const LOCAL_CHAIN_ID = 31337

const files = (stateDir: string) => ({
	log: join(stateDir, "stack.log"),
	pid: join(stateDir, "stack.pid"),
	run: stackRunFile({ stateDir }),
	walletHandle: join(stateDir, "wallet", "handle.json"),
})

function anvilIndexOf(address: string): number {
	for (let i = 0; i < ANVIL_ACCOUNTS; i++) if (privateKeyToAccount(anvilKey(i)).address === getAddress(address)) return i
	throw new Error(`stack: ${address} is none of anvil's first ${ANVIL_ACCOUNTS} accounts`)
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
	let code: number | null = null
	child.once("exit", (c, signal) => {
		code = c ?? (signal ? 128 : 1)
	})
	let recorded = false
	try {
		recordGroup(f.pid, pgid)
		recorded = true
		const { circuitsDir, manifestPath, user, sender } = await untilReady(f.log, () => code)
		const { manifest, rollupVersion } = await checkedManifest(manifestPath)
		const account = (address: string) => ({ address: getAddress(address), index: anvilIndexOf(address) })
		const run: StackRun = { pgid, manifestPath, circuitsDir, accounts: { user: account(user), sender: account(sender) } }
		writeFileSync(f.walletHandle, JSON.stringify({ nodeUrl: manifest.aztecNode, l1ChainId: manifest.chainId, rollupVersion }))
		writeFileSync(f.run, JSON.stringify(run, null, 2))
	} catch (err) {
		await abandonBoot(f.pid, pgid, { recorded, unreaped: code === null, cli: CLI, graceMs: STOP_GRACE_MS })
		throw err
	}
	child.unref()
	console.log(`[e2e] stack up (pgid ${pgid}) — PP_STACK_MANIFEST=${stackRun({ stateDir }).manifestPath}`)
}

const [command, stateDir] = process.argv.slice(2)
if ((command !== "up" && command !== "down") || !stateDir) throw new Error("usage: bun scripts/e2e/stack.ts up|down <state-dir>")
await (command === "up" ? up(stateDir) : stopRecorded(files(stateDir).pid, CLI, STOP_GRACE_MS))
