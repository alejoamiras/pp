/**
 * Rehearsal part 1, on an anvil fork of Sepolia this run owns: `keys` into a scratch home, `fund`,
 * `deploy-pool`, `verify-deployment --pool-only`, the mock ASP for both owners (`asp --owner` twice),
 * `seed`, `seed --recipient` and `seed --demo`, all through the real CLIs with every guard; then each L1
 * key's gas against its budget.
 */
import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { sepoliaPoolUser } from "@pp/pp-env/sepolia"
import { claimPort, releaseNamed, releasePorts } from "@pp/run-isolation/ports"
import { CleanupStack, killGroup, type OwnedChild } from "@pp/run-isolation/process"
import { startForkAnvil } from "@pp/sepolia-fork/anvil"
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

export type ForkResult = { block: bigint; gas: Partial<Record<FundedRole, bigint>>; debit: bigint }

/** `forkUrl` is where the CLIs read, and the fork flag's value; `sendUrl` where they send. */
export type Ctx = Scratch & { dir: string; forkUrl: string; sendUrl: string }

/** `keys` in the scratch home, then the scratch file with every address in `expected` and a free ASP port. */
export async function scratchFile(c: Ctx, scratchHome: string, runId: string): Promise<Record<string, string>> {
	const keys = await runCli("keys", [], { ...c.env, HOME: scratchHome })
	if (keys.code !== 0) throw new Error(`keys exited ${keys.code}:\n${keys.out.trim()}`)
	const addresses = Object.fromEntries(keys.events.map((e) => [e.name as string, e.address as string]))
	// Claimed then released at once: the asp command claims the row itself, under its own run id.
	const aspPort = await claimPort(runId, "rehearse-asp")
	await releaseNamed([{ port: aspPort, service: "rehearse-asp", owner: runId }])
	const own = parseDeployment(JSON.parse(readFileSync(OWN, "utf8")))
	// The committed amounts, so the fork moves what the live run will.
	if (!own.expected) throw new Error(`${OWN} has no expected section; commit it from \`addresses\` first`)
	writeScratch(c, {
		...own,
		// Never the live send endpoint, which would carry a fork-signed transaction to Sepolia.
		network: { ...own.network, l1Rpc: c.forkUrl, l1SendRpc: c.sendUrl, aspPort },
		expected: expectedOf(addresses, own.expected.amounts),
	})
	return addresses
}

/** The mock ASP up, answering reads only and listening on its one port. */
async function startAsp(c: Ctx, cleanup: CleanupStack): Promise<{ asp: OwnedChild; url: string; logFile: string }> {
	const d = loadScratch(c)
	const logFile = join(c.dir, "asp.log")
	const owners = [d.expected?.canaryOwner, d.expected?.demoOwner].flatMap((o) => ["--owner", o as string])
	const asp = startCli("asp", [c.file, ...owners, "--rehearse-fork", c.forkUrl], c.env, logFile)
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
	const note = (d.expected as NonNullable<TestnetDeployment["expected"]>).amounts.note
	const client = createPublicClient({ transport: http(c.forkUrl) })
	const account = privateKeyToAccount(key)
	await client.request({ method: "anvil_setBalance", params: [account.address, numberToHex(parseEther("1"))] } as never)
	const chain = { ...sepolia, rpcUrls: { default: { http: [c.forkUrl] } } }
	const wallet = createWalletClient({ account, chain, transport: http(c.forkUrl) })
	const hash = await wallet.writeContract({
		address: pool.asset,
		abi: MINT_ABI,
		functionName: "mint",
		args: [account.address, 10n * note],
	})
	await client.waitForTransactionReceipt({ hash })
	const deployment = {
		pool: pool.poolVault,
		entrypoint: pool.entrypoint,
		keystore: pool.keystore,
		aspRegistry: pool.aspRegistry,
		deployBlock: BigInt(pool.deployBlock),
	}
	const user = await sepoliaPoolUser({
		rpcUrl: c.forkUrl,
		sendRpcUrl: c.sendUrl,
		chainId: SEPOLIA,
		deployment,
		aspUrl: pool.aspApiUrl,
		key: key as Hex,
	})
	await user.registerKeystore()
	return { user, asset: pool.asset, note }
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
	const own = await other.user.deposit({ asset: other.asset, value: other.note })
	await must(c, "seed", [c.file, "--recipient", other.user.address])
	await untilLeaves(url, 2, 300_000)
	await other.user.sync()
	const notes = other.user.notes()
	const pending = notes.find((n) => n.label === own.label)?.status
	const received = notes.find((n) => n.label !== own.label)?.status
	if (pending !== "PENDING" || received !== "ACTIVE")
		throw new Error(`the stranger's own note is ${pending} and its received note ${received}; expected PENDING and ACTIVE`)
	c.log("[fork] the owner's deposit and its deposit for a registered recipient approved; the stranger's own stays pending")
	await demoDeposit(c, url)
	return debit
}

/** `seed --demo`: the demo owner registers itself, then the canary owner's deposit for it is approved. */
async function demoDeposit(c: Ctx, url: string): Promise<void> {
	const demoOwner = loadScratch(c).expected?.demoOwner as string
	const seeded = (await must(c, "seed", [c.file, "--demo"])).find((e) => e.event === "seeded")
	if (String(seeded?.recipient).toLowerCase() !== demoOwner.toLowerCase())
		throw new Error(`seed --demo deposited for ${String(seeded?.recipient)}, not the demo owner ${demoOwner}`)
	await untilLeaves(url, 3, 300_000)
	c.log("[fork] the deposit for the demo owner approved")
}

/** What {@link onFork} hands its body: the fork at a finalized block, and the CLIs' environment. */
export type OnFork = {
	runId: string
	dir: string
	block: bigint
	fork: Awaited<ReturnType<typeof startForkAnvil>>
	env: NodeJS.ProcessEnv
	cleanup: CleanupStack
}

/**
 * Runs `body` on an anvil fork of Sepolia at its last finalized block, with a scratch home for `keys`.
 * On success the run's directory goes; on failure only its scratch home does, and its logs stay.
 */
export async function onFork<T>(runId: string, tag: string, log: (line: string) => void, body: (f: OnFork) => Promise<T>): Promise<T> {
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
		log(`[${tag}] Sepolia fork at block ${block}`)
		const out = await body({ runId, dir, block, fork, env, cleanup })
		rmSync(dir, { recursive: true, force: true })
		return out
	} catch (e) {
		rmSync(join(dir, "home"), { recursive: true, force: true })
		log(`[${tag}] failed; its logs stay in ${dir}, and its scratch home with the scratch key file is deleted`)
		throw e
	} finally {
		await cleanup.run()
	}
}

export const forkRehearsal = (log: (line: string) => void): Promise<ForkResult> =>
	onFork(`pp-testnet-rehearse-${process.pid}`, "fork", log, async ({ runId, dir, block, fork, env, cleanup }) => {
		const c: Ctx = {
			dir,
			file: join(dir, "testnet-own.json"),
			env,
			forkUrl: fork.url,
			sendUrl: fork.url,
			log,
			modeArgs: ["--rehearse-fork", fork.url],
			tag: "fork",
			outputs: [],
		}
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
		if (!gas.demoOwner) throw new Error("the demo owner spent no gas, so its keystore was not registered from its own key")
		return { block, gas, debit }
	})
