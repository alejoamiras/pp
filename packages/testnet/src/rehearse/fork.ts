/**
 * Rehearsal part 1, on an anvil fork of Sepolia this run owns: `keys` into a scratch home, `fund`,
 * `deploy-pool`, `verify-deployment --pool-only`, the mock ASP (`asp --owner`), `seed` and
 * `seed --recipient`, all through the real CLIs with every guard; then each L1 key's gas against its budget.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { sepoliaPoolUser } from "@pp/pp-env/sepolia"
import { claimPort, releaseNamed } from "@pp/run-isolation/ports"
import { CleanupStack, killGroup, type OwnedChild } from "@pp/run-isolation/process"
import { startForkAnvil } from "@pp/sepolia-fork/src/anvil.ts"
import { type Address, createPublicClient, createWalletClient, type Hex, http, numberToHex, parseAbi, parseEther } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { sepolia } from "viem/chains"
import { FUNDING_GAS, type FundedRole } from "../funding"
import { generateKey } from "../keyfile"
import { SEPOLIA } from "../network"
import { committedClassIds } from "../pins"
import { parseDeployment, serializeDeployment, type TestnetDeployment } from "../schema"
import { type CliRun, type Event, listeningPorts, runCli, startCli, untilEvent } from "./runner"

const OWN = fileURLToPath(new URL("../../deployments/testnet-own.json", import.meta.url))
const MINT_ABI = parseAbi(["function mint(address to, uint256 amount)"])
const NOTE = 100n

export type ForkResult = { block: bigint; gas: Partial<Record<FundedRole, bigint>>; debit: bigint }

type Ctx = { dir: string; file: string; env: NodeJS.ProcessEnv; forkUrl: string; log: (line: string) => void }

/** Runs `name`; anything but exit 0 fails the rehearsal with the CLI's own output. */
async function must(c: Ctx, name: string, args: readonly string[], env = c.env): Promise<Event[]> {
	const t0 = performance.now()
	const r: CliRun = await runCli(name, [...args, "--rehearse-fork", c.forkUrl], env)
	if (r.code !== 0) throw new Error(`${name} exited ${r.code}:\n${r.out.trim()}`)
	c.log(`[fork] ${name} ${Math.round(performance.now() - t0)} ms`)
	return r.events
}

const write = (c: Ctx, d: TestnetDeployment) => writeFileSync(c.file, serializeDeployment(d))
const load = (c: Ctx) => parseDeployment(JSON.parse(readFileSync(c.file, "utf8")))

function expectedOf(a: Record<string, string>): TestnetDeployment["expected"] {
	const at = (name: string) => a[name] as `0x${string}`
	return {
		guardian: at("GUARDIAN_KEY"),
		lifetimeCap: 1_000_000_000_000n,
		l1Deployer: at("L1_DEPLOYER_KEY"),
		l2Deployer: at("L2_DEPLOYER_SECRET"),
		botPoster: at("BOT_POSTER_SECRET"),
		aspPostman: at("ASP_POSTMAN_KEY"),
		poolDeployer: at("POOL_DEPLOYER_KEY"),
		canaryOwner: at("CANARY_OWNER_KEY"),
		canarySender: at("CANARY_SENDER_KEY"),
		birthIntake: at("BOT_INTAKE_SECRET"),
		tokenClassId: committedClassIds().labelledToken as `0x${string}`,
		amounts: { debit: NOTE, note: NOTE, bridge: NOTE },
	} as unknown as TestnetDeployment["expected"]
}

/** `keys` in the scratch home, then the scratch file with every address in `expected` and a free ASP port. */
async function scratchFile(c: Ctx, scratchHome: string, runId: string): Promise<Record<string, string>> {
	const keys = await runCli("keys", [], { ...c.env, HOME: scratchHome })
	if (keys.code !== 0) throw new Error(`keys exited ${keys.code}:\n${keys.out.trim()}`)
	const addresses = Object.fromEntries(keys.events.map((e) => [e.name as string, e.address as string]))
	// Claimed then released at once: the asp command claims the row itself, under its own run id.
	const aspPort = await claimPort(runId, "rehearse-asp")
	await releaseNamed([{ port: aspPort, service: "rehearse-asp", owner: runId }])
	const own = parseDeployment(JSON.parse(readFileSync(OWN, "utf8")))
	write(c, { ...own, network: { ...own.network, l1Rpc: c.forkUrl, aspPort }, expected: expectedOf(addresses) })
	return addresses
}

/** Moves a candidate section a run wrote into the scratch file. */
function promote(c: Ctx, events: Event[], event: string): void {
	const path = events.find((e) => e.event === event)?.candidate
	if (typeof path !== "string") throw new Error(`${event} named no candidate`)
	write(c, { ...load(c), ...JSON.parse(readFileSync(path, "utf8")) })
}

/** The mock ASP up, answering reads only and listening on its one port. */
async function startAsp(c: Ctx, cleanup: CleanupStack): Promise<{ asp: OwnedChild; url: string; logFile: string }> {
	const d = load(c)
	const logFile = join(c.dir, "asp.log")
	const asp = startCli("asp", [c.file, "--owner", d.expected?.canaryOwner as string, "--rehearse-fork", c.forkUrl], c.env, logFile)
	cleanup.push(async () => void (await killGroup(asp)))
	const url = (await untilEvent(logFile, "asp-ready", asp, 300_000)).url as string
	const admin = await fetch(`${url}/admin/approve-label`, { method: "POST", body: '{"label":"0x01"}' })
	if (admin.status !== 404) throw new Error(`POST /admin/approve-label answered ${admin.status}, not 404`)
	const ports = listeningPorts(asp.child.pid as number)
	if (ports.join() !== String(d.network.aspPort)) throw new Error(`the asp group listens on ${ports.join(", ")}`)
	c.log(`[fork] asp ready on its one port; POST /admin answers 404`)
	return { asp, url, logFile }
}

/** A depositor the ASP must not approve, holding minted test tokens, registered so it can also receive. */
async function stranger(c: Ctx) {
	const key = generateKey("l1")
	const d = load(c)
	const pool = d.pool as NonNullable<TestnetDeployment["pool"]>
	const client = createPublicClient({ transport: http(c.forkUrl) })
	const account = privateKeyToAccount(key)
	await client.request({ method: "anvil_setBalance", params: [account.address, numberToHex(parseEther("1"))] } as never)
	const chain = { ...sepolia, rpcUrls: { default: { http: [c.forkUrl] } } }
	const wallet = createWalletClient({ account, chain, transport: http(c.forkUrl) })
	const hash = await wallet.writeContract({
		address: pool.asset,
		abi: MINT_ABI,
		functionName: "mint",
		args: [account.address, 10n * NOTE],
	})
	await client.waitForTransactionReceipt({ hash })
	const deployment = {
		pool: pool.poolVault,
		entrypoint: pool.entrypoint,
		keystore: pool.keystore,
		aspRegistry: pool.aspRegistry,
		deployBlock: BigInt(pool.deployBlock),
	}
	const user = await sepoliaPoolUser({ rpcUrl: c.forkUrl, chainId: SEPOLIA, deployment, aspUrl: pool.aspApiUrl, key: key as Hex })
	await user.registerKeystore()
	return { user, asset: pool.asset }
}

/** Polls the ASP's leaves until `n` labels are in the set. */
async function untilLeaves(url: string, n: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const { leaves } = (await (await fetch(`${url}/association-set/leaves`)).json()) as { leaves: string[] }
		if (leaves.length === n) return
		if (leaves.length > n) throw new Error(`the ASP approved ${leaves.length} labels, expected ${n}`)
		if (Date.now() > deadline) throw new Error(`the ASP had ${leaves.length} of ${n} labels after ${timeoutMs} ms`)
		await new Promise((r) => setTimeout(r, 1_000))
	}
}

/** Gas each sender spent in blocks after `from`, by lower-case address. */
async function gasBySender(url: string, from: bigint): Promise<Map<string, bigint>> {
	const client = createPublicClient({ transport: http(url) })
	const head = await client.getBlockNumber()
	const gas = new Map<string, bigint>()
	for (let n = from + 1n; n <= head; n++) {
		const receipts = (await client.request({ method: "eth_getBlockReceipts", params: [numberToHex(n)] } as never)) as {
			from: string
			gasUsed: Hex
		}[]
		for (const r of receipts) gas.set(r.from.toLowerCase(), (gas.get(r.from.toLowerCase()) ?? 0n) + BigInt(r.gasUsed))
	}
	return gas
}

const ROLE_KEY: Record<FundedRole, string> = {
	l1Deployer: "L1_DEPLOYER_KEY",
	poolDeployer: "POOL_DEPLOYER_KEY",
	aspPostman: "ASP_POSTMAN_KEY",
	guardian: "GUARDIAN_KEY",
	canaryOwner: "CANARY_OWNER_KEY",
	canarySender: "CANARY_SENDER_KEY",
}

/** Each funded role's gas in this part; any over its budget fails the rehearsal. */
function budgetCheck(gas: Map<string, bigint>, addresses: Record<string, string>): ForkResult["gas"] {
	const out: ForkResult["gas"] = {}
	for (const [role, name] of Object.entries(ROLE_KEY) as [FundedRole, string][]) {
		const used = gas.get((addresses[name] ?? "").toLowerCase()) ?? 0n
		if (used > FUNDING_GAS[role]) throw new Error(`${role} spent ${used} gas, over its budget of ${FUNDING_GAS[role]}`)
		out[role] = used
	}
	return out
}

async function approvals(c: Ctx, url: string): Promise<bigint> {
	const seeded = await must(c, "seed", [c.file])
	const debit = BigInt(seeded.find((e) => e.event === "seeded")?.debit as string)
	const other = await stranger(c)
	const own = await other.user.deposit({ asset: other.asset, value: NOTE })
	await must(c, "seed", [c.file, "--recipient", other.user.address])
	await untilLeaves(url, 2, 300_000)
	await other.user.sync()
	const notes = other.user.notes()
	const pending = notes.find((n) => n.label === own.label)?.status
	const received = notes.find((n) => n.label !== own.label)?.status
	if (pending !== "PENDING" || received !== "ACTIVE")
		throw new Error(`the stranger's own note is ${pending} and its received note ${received}; expected PENDING and ACTIVE`)
	c.log("[fork] the owner's deposit and its deposit for a registered recipient approved; the stranger's own stays pending")
	return debit
}

export async function forkRehearsal(log: (line: string) => void): Promise<ForkResult> {
	const cleanup = new CleanupStack()
	const runId = `pp-testnet-rehearse-${process.pid}`
	const dir = join(homedir(), ".cache", "pp", "testnet", "rehearse", runId)
	mkdirSync(join(dir, "home"), { recursive: true, mode: 0o700 })
	try {
		const own = parseDeployment(JSON.parse(readFileSync(OWN, "utf8")))
		const live = createPublicClient({ transport: http(own.network.l1Rpc) })
		const block = (await live.getBlock({ blockTag: "finalized" })).number
		const fork = await startForkAnvil({ endpoint: own.network.l1Rpc, block, runId, dataDir: dir, cleanup })
		const env = { PATH: process.env.PATH, HOME: homedir(), PP_TESTNET_SCRATCH_HOME: join(dir, "home") }
		const c: Ctx = { dir, file: join(dir, "testnet-own.json"), env, forkUrl: fork.url, log }
		log(`[fork] Sepolia fork at block ${block}`)
		const addresses = await scratchFile(c, join(dir, "home"), runId)
		await fork.rpc("anvil_setBalance", [addresses.L1_DEPLOYER_KEY as Address, numberToHex(parseEther("10"))])
		await must(c, "fund", [c.file])
		promote(c, await must(c, "deploy-pool", [c.file]), "pool-deployed")
		await must(c, "verify-deployment", [c.file, "--pool-only"])
		const { asp, url, logFile } = await startAsp(c, cleanup)
		const debit = await approvals(c, url)
		if (!(await killGroup(asp)) || asp.exitReason() !== "exit code 0" || !readFileSync(logFile, "utf8").includes('"asp-stopped"'))
			throw new Error(`the asp did not stop clean (${asp.exitReason()})`)
		const gas = budgetCheck(await gasBySender(fork.url, block), addresses)
		rmSync(dir, { recursive: true, force: true })
		return { block, gas, debit }
	} catch (e) {
		log(`[fork] failed; its logs and scratch files stay in ${dir}`)
		throw e
	} finally {
		await cleanup.run()
	}
}
