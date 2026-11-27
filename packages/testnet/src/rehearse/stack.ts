/**
 * Rehearsal part 2, on a running local stack (`PP_STACK_MANIFEST`): `addresses`, `deploy`,
 * `verify-deployment`, `bot` stopped and restarted, `verify-deployment --bot`, `open`, the canary with its
 * shield, and `pause`, all through the real CLIs with `--rehearse` and anvil's well-known keys, never the
 * key file; then the guardian's and the canary sender's gas against their budgets.
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { parseStackManifest } from "@pp/bridge-core"
import { claimPort, releaseNamed } from "@pp/run-isolation/ports"
import { CleanupStack, killGroup, type OwnedChild } from "@pp/run-isolation/process"
import { createPublicClient, type Hex, http, parseAbi, toHex } from "viem"
import { mnemonicToAccount } from "viem/accounts"
import type { FundedRole } from "../funding"
import { generateKey, KEY_NAMES } from "../keyfile"
import { LOCAL } from "../network"
import { parseDeployment, type TestnetDeployment } from "../schema"
import { budgetCheck, gasBySender } from "./gas"
import { type Event, startCli, untilEvent } from "./runner"
import { assertNoKeyIn, expectedOf, loadScratch, must, promote, type Scratch, writeScratch } from "./scratch"

const OWN = fileURLToPath(new URL("../../deployments/testnet-own.json", import.meta.url))
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk"
/**
 * Anvil indices: 0 publishes for the node and 12 to 15 are the stack's actors, so this part signs with 2 to 4.
 * 13, the stack's seeded user with two approved 100-unit notes, is the canary owner; 14 deployed the
 * stack's pool and holds its postman role, so `expected` names it for both and nothing here signs with it.
 * The demo accounts are named here, never signed with: 5 and 6, which neither the stack nor the suites
 * that share its anvil (9 to 12) use.
 */
type L1KeyName = Extract<(typeof KEY_NAMES)[number], { kind: "l1" }>["name"]
const L1_INDEX: Record<L1KeyName, number> = {
	L1_DEPLOYER_KEY: 2,
	GUARDIAN_KEY: 3,
	CANARY_SENDER_KEY: 4,
	DEMO_OWNER_KEY: 5,
	DEMO_SENDER_KEY: 6,
	ASP_POSTMAN_KEY: 14,
	POOL_DEPLOYER_KEY: 14,
	CANARY_OWNER_KEY: 13,
}
const PERMISSIONED_ABI = parseAbi(["function ACCESS_ROUTER() view returns (address)"])
export const AMOUNTS = { debit: 100n, note: 100n, bridge: 10n, shield: 2n }
const BOT_READY_MS = 15 * 60_000

export type StackResult = { gas: Partial<Record<FundedRole, bigint>>; firstPost: bigint; restartPost: bigint }

const anvilKey = (index: number): Hex => {
	const key = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index }).getHdKey().privateKey
	if (!key) throw new Error(`no key at anvil index ${index}`)
	return toHex(key)
}

/** Every key a CLI reads in this part: anvil's for L1, fresh for L2; passed as `PP_REHEARSE_<name>` only. */
function rehearsalKeys(): Record<string, Hex> {
	return Object.fromEntries(
		KEY_NAMES.map(({ name, kind }) => [name, kind === "l1" ? anvilKey(L1_INDEX[name as L1KeyName]) : generateKey("l2")]),
	)
}

/** The scratch file's network from the stack's manifest and its node, and the stack's pool as `pool`. */
export async function stackFile(s: Scratch, manifestPath: string, runId: string): Promise<void> {
	const m = parseStackManifest(JSON.parse(readFileSync(manifestPath, "utf8")))
	// Chain 31337's manifest holds only loopback URLs, so nothing below reaches another host.
	if (m.chainId !== LOCAL) throw new Error(`${manifestPath} is a chain ${m.chainId} manifest; a stack rehearsal runs on ${LOCAL}`)
	const info = await createAztecNodeClient(m.aztecNode).getNodeInfo()
	const a = info.l1ContractAddresses
	// Claimed then released at once: the bot claims the row itself, under its own run id.
	const botPort = await claimPort(runId, "rehearse-bot")
	await releaseNamed([{ port: botPort, service: "rehearse-bot", owner: runId }])
	const own = parseDeployment(JSON.parse(readFileSync(OWN, "utf8")))
	const l1 = createPublicClient({ transport: http(m.l1Rpc) })
	const accessRouter = await l1.readContract({ address: m.pool.entrypoint, abi: PERMISSIONED_ABI, functionName: "ACCESS_ROUTER" })
	writeScratch(s, {
		target: "own",
		bundle: own.bundle,
		network: {
			l1ChainId: LOCAL,
			rollup: a.rollupAddress.toString() as Hex,
			l1Registry: a.registryAddress.toString() as Hex,
			inbox: a.inboxAddress.toString() as Hex,
			outbox: a.outboxAddress.toString() as Hex,
			rollupVersion: info.rollupVersion,
			fpc: own.network.fpc,
			l1Rpc: m.l1Rpc,
			aztecNode: m.aztecNode,
			botPort,
			aspPort: Number(new URL(m.pool.aspApiUrl).port),
		},
		pool: { ...m.pool, accessRouter },
	} as unknown as TestnetDeployment)
}

/** A stop mid-post lets the post drain for up to 10 s before the bot stops its wallet and server. */
const BOT_STOP_GRACE_MS = 30_000

/** The bot up until its first checkpointed post. */
export async function startBot(
	s: Scratch,
	dir: string,
	n: number,
	cleanup: CleanupStack,
): Promise<{ bot: OwnedChild; ready: Event; log: string }> {
	const log = join(dir, `bot-${n}.log`)
	const bot = startCli("bot", [s.file, ...s.modeArgs], s.env, log)
	cleanup.push(async () => void (await killGroup(bot, BOT_STOP_GRACE_MS)))
	const ready = await untilEvent(log, "bot-ready", bot, BOT_READY_MS)
	s.log(`[${s.tag}] bot ${n} posted sequence ${ready.sequence} (${ready.txHash})`)
	return { bot, ready, log }
}

export async function stopBot(s: Scratch, b: { bot: OwnedChild; log: string }): Promise<void> {
	const stopped = await killGroup(b.bot, BOT_STOP_GRACE_MS)
	const out = readFileSync(b.log, "utf8")
	s.outputs.push(out)
	if (!stopped || b.bot.exitReason() !== "exit code 0" || !out.includes('"bot-stopped"'))
		throw new Error(`the bot did not stop clean (${b.bot.exitReason()})`)
}

/** `deploy`, then `verify-deployment` on the promoted bridge; returns its factory. */
export async function deployBridge(s: Scratch): Promise<`0x${string}`> {
	promote(s, await must(s, "deploy", [s.file]), "deployed")
	await must(s, "verify-deployment", [s.file])
	return loadScratch(s).bridge?.factory as `0x${string}`
}

/** The canary must exit 0; its report stays in its run dir for a failure. */
async function canary(s: Scratch, post: Event): Promise<void> {
	const events = await must(s, "canary", [s.file, "--min-sequence", String(post.sequence), "--post", String(post.txHash)])
	const report = events.find((e) => e.event === "canary-report")
	if (report?.exitClass !== "PASS") throw new Error(`the canary reported ${String(report?.exitClass)}`)
	s.outputs.push(readFileSync(String(report.path), "utf8"))
}

export type StackRun = { runId: string; dir: string; keys: Record<string, Hex>; s: Scratch }

/** A part's run directory under `~/.cache/pp`, its keys passed as `PP_REHEARSE_<name>`, and its scratch file's path. */
export function stackRun(tag: string, manifestPath: string, log: (line: string) => void): StackRun {
	const runId = `pp-testnet-rehearse-${tag}-${process.pid}`
	const dir = join(homedir(), ".cache", "pp", "testnet", "rehearse", runId)
	mkdirSync(dir, { recursive: true, mode: 0o700 })
	const keys = rehearsalKeys()
	const env = {
		PATH: process.env.PATH,
		HOME: homedir(),
		PP_TESTNET_RUN_ROOT: join(dir, "runs"),
		...Object.fromEntries(Object.entries(keys).map(([name, v]) => [`PP_REHEARSE_${name}`, v])),
	}
	const s: Scratch = { file: join(dir, "testnet-own.json"), env, modeArgs: ["--rehearse", manifestPath], tag, log, outputs: [] }
	return { runId, dir, keys, s }
}

export async function stackRehearsal(manifestPath: string, log: (line: string) => void): Promise<StackResult> {
	const cleanup = new CleanupStack()
	const { runId, dir, keys, s } = stackRun("stack", manifestPath, log)
	try {
		await stackFile(s, manifestPath, runId)
		const l1 = createPublicClient({ transport: http(loadScratch(s).network.l1Rpc) })
		const from = await l1.getBlockNumber()
		const named = (await must(s, "addresses", [s.file])).find((e) => e.event === "addresses") as Record<string, string>
		writeScratch(s, { ...loadScratch(s), expected: expectedOf(named, AMOUNTS) })
		const factory = await deployBridge(s)
		const first = await startBot(s, dir, 1, cleanup)
		await stopBot(s, first)
		const second = await startBot(s, dir, 2, cleanup)
		// The record against the registry; the canary itself checks its label at `--min-sequence`.
		await must(s, "verify-deployment", [s.file, "--bot"])
		await must(s, "open", [s.file, "--factory", factory])
		await canary(s, second.ready)
		await must(s, "pause", [s.file, "--factory", factory])
		await stopBot(s, second)
		assertNoKeyIn(s.outputs, Object.values(keys))
		const addresses = Object.fromEntries(Object.entries(named).filter(([k]) => k !== "event"))
		const gas = budgetCheck(await gasBySender(loadScratch(s).network.l1Rpc, from), addresses)
		rmSync(dir, { recursive: true, force: true })
		return { gas, firstPost: BigInt(String(first.ready.sequence)), restartPost: BigInt(String(second.ready.sequence)) }
	} catch (e) {
		log(`[stack] failed; its logs and scratch files stay in ${dir}`)
		throw e
	} finally {
		await cleanup.run()
	}
}
