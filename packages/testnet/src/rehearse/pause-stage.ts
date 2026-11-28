/**
 * What every pause case stands on: its own anvil with the factory deployed, entries paused, a miner it
 * drives, an optional misbehaving backend in front, a deployment file naming them, and the real `pause`
 * CLI run as its own process group with `--rehearse` and anvil's well-known guardian key.
 */
import { writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { PORTAL_FACTORY_ABI, parseStackManifest, serializeStackManifest } from "@pp/bridge-core"
import { claimPort } from "@pp/run-isolation/ports"
import { type CleanupStack, killGroup, type OwnedChild } from "@pp/run-isolation/process"
import {
	type Address,
	createPublicClient,
	createWalletClient,
	encodeFunctionData,
	type Hash,
	type Hex,
	http,
	numberToHex,
	pad,
	type PrivateKeyAccount,
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { LOCAL, loopback } from "../network"
import { serializeDeployment, type TestnetDeployment } from "../schema"
import {
	anvilKey,
	deployFactory,
	localChain,
	type LocalChain,
	type Miner,
	STUB_REGISTRY,
	STUB_ROLLUP,
	STUB_ROLLUP_WORD,
	startLocalAnvil,
	startMiner,
} from "./local-chain"
import { startRpcProxy, type RpcProxy } from "./rpc-proxy"
import { type CliRun, type Event, ended, startCli, untilEvent } from "./runner"

export type CaseCtx = { name: string; runId: string; dir: string; cleanup: CleanupStack; log: (line: string) => void }

export const DEPLOYER_KEY = anvilKey(0)
export const GUARDIAN_KEY = anvilKey(1)

/** A placeholder address `0x…b0nn`: a field the commands these cases run never read. */
const unread = (n: number): Address => pad(numberToHex(0xb000 + n), { size: 20 })
const word = (n: number): Hex => pad(numberToHex(n), { size: 32 })
/** The bot and ASP ports a file must name; nothing these cases run binds them. */
const UNBOUND = 65_000

/** A deployment file for the local chain: the stub rollup, anvil's accounts, and `bridge` or `pool` as given. */
export function fixtureFile(o: {
	l1Rpc: string
	aztecNode: string
	bridge?: TestnetDeployment["bridge"]
	pool?: boolean
}): TestnetDeployment {
	const guardian = privateKeyToAccount(GUARDIAN_KEY).address
	const deployer = privateKeyToAccount(DEPLOYER_KEY).address
	const network: TestnetDeployment["network"] = {
		l1ChainId: LOCAL,
		rollup: STUB_ROLLUP,
		l1Registry: STUB_REGISTRY,
		inbox: pad(numberToHex(STUB_ROLLUP_WORD), { size: 20 }),
		outbox: pad(numberToHex(STUB_ROLLUP_WORD), { size: 20 }),
		rollupVersion: Number(STUB_ROLLUP_WORD),
		fpc: word(1),
		l1Rpc: o.l1Rpc,
		aztecNode: o.aztecNode,
		botPort: UNBOUND,
		aspPort: UNBOUND + 1,
	}
	const expected = {
		guardian,
		lifetimeCap: 1n,
		l1Deployer: deployer,
		l2Deployer: word(2),
		botPoster: word(3),
		aspPostman: deployer,
		poolDeployer: deployer,
		canaryOwner: unread(10),
		canarySender: unread(11),
		birthIntake: word(0),
		tokenClassId: word(4),
		amounts: { debit: 1n, note: 1n, bridge: 1n },
	}
	const pool = {
		...Object.fromEntries(
			["poolVault", "entrypoint", "aspRegistry", "keystore", "asset", "accessRouter", "relay"].map((k, i) => [k, unread(20 + i)]),
		),
		deployBlock: 0n,
		aspApiUrl: loopback(UNBOUND + 1),
	} as NonNullable<TestnetDeployment["pool"]>
	return {
		network,
		target: "own",
		bundle: "ceremony",
		expected,
		...(o.pool ? { pool } : {}),
		...(o.bridge ? { bridge: o.bridge } : {}),
	}
}

/**
 * Writes the stack manifest `--rehearse` names beside the case's file: the file's own endpoints and the
 * fixture pool, so the guard compares the file with a manifest that passes the strict schema.
 * @returns the manifest's path
 */
export function writeCaseManifest(c: CaseCtx, file: TestnetDeployment): string {
	const {
		accessRouter: _router,
		relay: _relay,
		...pool
	} = fixtureFile({ ...file.network, pool: true }).pool as NonNullable<TestnetDeployment["pool"]>
	const manifest = parseStackManifest(
		JSON.parse(
			JSON.stringify({ version: 1, chainId: LOCAL, l1Rpc: file.network.l1Rpc, aztecNode: file.network.aztecNode, pool }, (_k, v) =>
				typeof v === "bigint" ? v.toString() : v,
			),
		),
	)
	const path = join(c.dir, `${c.name}.stack.json`)
	writeFileSync(path, serializeStackManifest(manifest))
	return path
}

export type Stage = {
	c: CaseCtx
	chain: LocalChain
	miner: Miner
	proxy: RpcProxy | undefined
	factory: Address
	file: string
	manifest: string
	guardian: PrivateKeyAccount
}

/**
 * The case's anvil with the factory deployed (entries paused), automine off and the miner running; with
 * `proxy`, the file's L1 URL is a misbehaving backend in front of the anvil, whose rules start off.
 */
export async function stage(c: CaseCtx, o: { proxy?: boolean } = {}): Promise<Stage> {
	const chain = await startLocalAnvil({ runId: c.runId, service: `${c.name}-anvil`, dir: c.dir, cleanup: c.cleanup })
	const guardian = privateKeyToAccount(GUARDIAN_KEY)
	const f = await deployFactory(chain, DEPLOYER_KEY, guardian.address)
	const miner = await startMiner(chain.rpc)
	c.cleanup.push(() => miner.stop())
	let proxy: RpcProxy | undefined
	if (o.proxy) {
		proxy = await startRpcProxy(chain.url, await claimPort(c.runId, `${c.name}-proxy`))
		c.cleanup.push(() => (proxy as RpcProxy).close())
	}
	const bridge = {
		factory: f.factory,
		portal: unread(1),
		hub: word(5),
		token: word(6),
		registry: word(7),
		deployBlock: f.block,
		factoryTx: f.tx,
	}
	const file = join(c.dir, `${c.name}.json`)
	const d = fixtureFile({ l1Rpc: proxy?.url ?? chain.url, aztecNode: loopback(UNBOUND + 2), bridge })
	writeFileSync(file, serializeDeployment(d))
	return { c, chain, miner, proxy, factory: f.factory, file, manifest: writeCaseManifest(c, d), guardian }
}

const publicClient = (s: Stage) => createPublicClient({ transport: http(s.chain.url) })

/** The guardian's mined nonce, read from the anvil itself. */
export const nonceOf = async (s: Stage): Promise<number> =>
	Number(await s.chain.rpc<Hex>("eth_getTransactionCount", [s.guardian.address, "latest"]))

export const pausedNow = (s: Stage): Promise<boolean> =>
	publicClient(s).readContract({ address: s.factory, abi: PORTAL_FACTORY_ABI, functionName: "entriesPaused" })

export const receiptOf = (s: Stage, hash: Hash) => s.chain.rpc<{ status: Hex } | null>("eth_getTransactionReceipt", [hash])

/** Whether the anvil holds `hash`, pending or mined. */
export const knows = async (s: Stage, hash: Hash): Promise<boolean> => (await s.chain.rpc("eth_getTransactionByHash", [hash])) !== null

/**
 * The transaction `open` sends, signed by the guardian at its mined nonce and handed to `o.via` (the
 * anvil itself by default); `o.feeFactor` scales the fee estimate, for an open signed while fees were higher.
 */
export async function sendOpen(s: Stage, o: { feeFactor?: bigint; via?: string } = {}): Promise<{ hash: Hash; nonce: number }> {
	const feeFactor = o.feeFactor ?? 1n
	const url = o.via ?? s.chain.url
	const wallet = createWalletClient({ account: s.guardian, chain: localChain(url), transport: http(url) })
	const fees = await publicClient(s).estimateFeesPerGas()
	const nonce = await nonceOf(s)
	const hash = await wallet.sendTransaction({
		to: s.factory,
		data: encodeFunctionData({ abi: PORTAL_FACTORY_ABI, functionName: "setEntriesPaused", args: [false] }),
		nonce,
		maxFeePerGas: fees.maxFeePerGas * feeFactor,
		maxPriorityFeePerGas: fees.maxPriorityFeePerGas * feeFactor,
	})
	return { hash, nonce }
}

/** Polls `check` until it holds; rejects naming `what` after `timeoutMs`. */
export async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 60_000): Promise<void> {
	for (const deadline = Date.now() + timeoutMs; !(await check()); ) {
		if (Date.now() > deadline) throw new Error(`${what}: not within ${timeoutMs} ms`)
		await Bun.sleep(200)
	}
}

export type Running = { child: OwnedChild; logFile: string; t0: number }

let runs = 0

/** `pause` against the case's file as its own process group; its log stays in the case's directory. */
export function startPause(s: Stage, args: readonly string[]): Running {
	const logFile = join(s.c.dir, `pause-${++runs}.log`)
	const env = {
		PATH: process.env.PATH ?? "",
		HOME: homedir(),
		PP_TESTNET_RUN_ROOT: join(s.c.dir, "runs"),
		PP_REHEARSE_GUARDIAN_KEY: GUARDIAN_KEY,
	}
	const child = startCli("pause", [s.file, "--factory", s.factory, ...args, "--rehearse", s.manifest], env, logFile)
	s.c.cleanup.push(async () => void (await killGroup(child)))
	return { child, logFile, t0: performance.now() }
}

export const signedEvent = (r: Running, timeoutMs = 120_000): Promise<Event> => untilEvent(r.logFile, "pause-signed", r.child, timeoutMs)

/** The CLI's outcome, with its wall time in ms. */
export async function finished(r: Running, timeoutMs: number): Promise<CliRun & { ms: number }> {
	const run = await ended(r.child, r.logFile, timeoutMs)
	return { ...run, ms: Math.round(performance.now() - r.t0) }
}

/** A short `pause` run to its end. */
export const pause = (s: Stage, args: readonly string[], timeoutMs = 300_000) => finished(startPause(s, args), timeoutMs)

const failure = (what: string, r: CliRun) => new Error(`${what}: exit ${r.code}\n${r.out.trim()}`)

/** Exit 0 with entries paused by a send at `nonce`; returns the `paused` event. */
export function expectPaused(r: CliRun, nonce: number, what: string): Event {
	const p = r.events.find((e) => e.event === "paused")
	if (r.code !== 0 || p?.nonce !== nonce) throw failure(`${what}: expected exit 0, paused at nonce ${nonce}`, r)
	return p
}

/** Exit 1 with `code` naming `nonce`. */
export function expectFailed(r: CliRun, code: string, nonce: number, what: string): void {
	const f = r.events.find((e) => e.event === "pause-failed")
	if (r.code !== 1 || f?.code !== code || f.nonce !== nonce) throw failure(`${what}: expected exit 1, ${code} at nonce ${nonce}`, r)
}

export function check(holds: boolean, what: string): void {
	if (!holds) throw new Error(what)
}
