/**
 * Rehearsal part 1, on an anvil fork of Sepolia this run owns: `keys` into a scratch home, `fund`,
 * `deploy-pool`, `verify-deployment --pool-only`, the mock ASP (`asp --owner`), `seed` and
 * `seed --recipient`, all through the real CLIs with every guard; then each L1 key's gas against its budget.
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { sepoliaPoolUser } from "@pp/pp-env/sepolia"
import { claimPort, releaseNamed, releasePorts } from "@pp/run-isolation/ports"
import { CleanupStack, killGroup, type OwnedChild } from "@pp/run-isolation/process"
import { startForkAnvil } from "@pp/sepolia-fork/src/anvil.ts"
import { type Address, createPublicClient, createWalletClient, type Hex, http, numberToHex, parseAbi, parseEther } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { sepolia } from "viem/chains"
import type { FundedRole } from "../funding"
import { generateKey } from "../keyfile"
import { SEPOLIA } from "../network"
import { parseDeployment, type TestnetDeployment } from "../schema"
import { budgetCheck, gasBySender } from "./gas"
import { listeningPorts, runCli, startCli, untilEvent } from "./runner"
import { expectedOf, loadScratch, must, promote, type Scratch, writeScratch } from "./scratch"

const OWN = fileURLToPath(new URL("../../deployments/testnet-own.json", import.meta.url))
const MINT_ABI = parseAbi(["function mint(address to, uint256 amount)"])
const NOTE = 100n
const AMOUNTS = { debit: NOTE, note: NOTE, bridge: NOTE }

export type ForkResult = { block: bigint; gas: Partial<Record<FundedRole, bigint>>; debit: bigint }

type Ctx = Scratch & { dir: string; forkUrl: string }

/** `keys` in the scratch home, then the scratch file with every address in `expected` and a free ASP port. */
async function scratchFile(c: Ctx, scratchHome: string, runId: string): Promise<Record<string, string>> {
	const keys = await runCli("keys", [], { ...c.env, HOME: scratchHome })
	if (keys.code !== 0) throw new Error(`keys exited ${keys.code}:\n${keys.out.trim()}`)
	const addresses = Object.fromEntries(keys.events.map((e) => [e.name as string, e.address as string]))
	// Claimed then released at once: the asp command claims the row itself, under its own run id.
	const aspPort = await claimPort(runId, "rehearse-asp")
	await releaseNamed([{ port: aspPort, service: "rehearse-asp", owner: runId }])
	const own = parseDeployment(JSON.parse(readFileSync(OWN, "utf8")))
	writeScratch(c, { ...own, network: { ...own.network, l1Rpc: c.forkUrl, aspPort }, expected: expectedOf(addresses, AMOUNTS) })
	return addresses
}

/** The mock ASP up, answering reads only and listening on its one port. */
async function startAsp(c: Ctx, cleanup: CleanupStack): Promise<{ asp: OwnedChild; url: string; logFile: string }> {
	const d = loadScratch(c)
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
	const d = loadScratch(c)
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
	const runId = `pp-testnet-rehearse-${process.pid}`
	const cleanup = new CleanupStack()
	cleanup.push(() => releasePorts(runId))
	const dir = join(homedir(), ".cache", "pp", "testnet", "rehearse", runId)
	mkdirSync(join(dir, "home"), { recursive: true, mode: 0o700 })
	try {
		const own = parseDeployment(JSON.parse(readFileSync(OWN, "utf8")))
		const live = createPublicClient({ transport: http(own.network.l1Rpc) })
		const block = (await live.getBlock({ blockTag: "finalized" })).number
		const fork = await startForkAnvil({ endpoint: own.network.l1Rpc, block, runId, dataDir: dir, cleanup })
		const env = {
			PATH: process.env.PATH,
			HOME: homedir(),
			PP_TESTNET_SCRATCH_HOME: join(dir, "home"),
			PP_TESTNET_RUN_ROOT: join(dir, "runs"),
		}
		const c: Ctx = {
			dir,
			file: join(dir, "testnet-own.json"),
			env,
			forkUrl: fork.url,
			log,
			modeArgs: ["--rehearse-fork", fork.url],
			tag: "fork",
			outputs: [],
		}
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
		rmSync(join(dir, "home"), { recursive: true, force: true })
		log(`[fork] failed; its logs stay in ${dir}, and its scratch home with the scratch key file is deleted`)
		throw e
	} finally {
		await cleanup.run()
	}
}
