// `@pp/pp-env/sepolia` end to end on a loopback anvil started with Sepolia's chain id. Only this
// test's setup writes code by cheat code (the canonical Poseidon libraries and ERC-5564 announcer
// that live Sepolia already holds); the entry under test never does.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { NoteStatus } from "#ppv2/evm-sdk"
import { claimPort, releasePorts } from "@pp/run-isolation/ports"
import { CleanupStack, killGroup, spawnOwned } from "@pp/run-isolation/process"
import { type Address, createPublicClient, createWalletClient, type Hex, http, parseAbiItem, type PublicClient } from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { sepolia } from "viem/chains"
import { createPoolUser } from "../../src/client/pool.ts"
import type { ClientConfig, PoolUser } from "../../src/client/types.ts"
import { checkout } from "../../src/env/checkout.ts"
import { installPoseidon, mintTestToken } from "../../src/env/deploy.ts"
import { ANVIL_ACCOUNTS, anvilKey, DEPLOYER_INDEX, LOG_DIR, USER_INDEX } from "../../src/env/harness/anvil.ts"
import { rpc, waitFor } from "../../src/env/harness/rpc.ts"
import { RUNS_DIR } from "../../src/env/index.ts"
import { anvilBin, cleanEnv } from "../../src/env/tools.ts"
import {
	deployPoolOn,
	type MockAsp,
	type SepoliaPool,
	type SepoliaPoolUser,
	sepoliaPoolUser,
	startMockAsp,
	verifyPoolCode,
} from "../../src/sepolia/index.ts"

const CHAIN = 11155111
const ANNOUNCER = "0x55649E01B5Df198D18D95b5cc5051630cfD45564"
const STRANGER_INDEX = 12
const VALUE = 100n
const ROOT_UPDATED = parseAbiItem("event ASPRootUpdated(uint256 indexed _root, bytes _ipfsCID)")
const runId = `sepolia-${Date.now().toString(36)}`

describe.skipIf(!process.env.PP_ENV_INTEGRATION)("@pp/pp-env/sepolia on a chain-11155111 anvil", () => {
	const cleanup = new CleanupStack()
	const postmanKey = generatePrivateKey()
	let rpcUrl: string
	let client: PublicClient
	let pool: SepoliaPool
	let asp: MockAsp
	let aspPort: number
	let owner: SepoliaPoolUser
	let stranger: PoolUser
	let ownerLabel: bigint
	let strangerLabel: bigint

	const wallet = (key: Hex) =>
		createWalletClient({
			chain: { ...sepolia, rpcUrls: { default: { http: [rpcUrl] } } },
			transport: http(rpcUrl),
			account: privateKeyToAccount(key),
		})
	const startAsp = () =>
		startMockAsp({
			rpcUrl,
			chainId: CHAIN,
			postmanKey,
			deployment: pool.deployment,
			port: aspPort,
			owners: [owner.address],
			pollMs: 200,
			log: (l) => console.log("[asp]", l),
		})
	const rootPosts = () =>
		client.getLogs({ address: pool.deployment.aspRegistry, event: ROOT_UPDATED, fromBlock: pool.deployment.deployBlock })
	const scannedPast = async (block: bigint) => waitFor("the mock ASP's scan", async () => asp.scanned() >= block, 30_000)

	beforeAll(async () => {
		const anvilPort = await claimPort(runId, "pp-env-anvil")
		aspPort = await claimPort(runId, "pp-env-asp")
		cleanup.push(() => releasePorts(runId))
		const args = [
			"--host",
			"127.0.0.1",
			"--port",
			String(anvilPort),
			"--chain-id",
			String(CHAIN),
			"--block-base-fee-per-gas",
			"7",
			"--accounts",
			String(ANVIL_ACCOUNTS),
			"--silent",
		]
		const anvil = spawnOwned(anvilBin(), args, join(LOG_DIR, `${runId}-anvil.log`), cleanEnv())
		cleanup.push(async () => {
			if (!(await killGroup(anvil))) throw new Error(`process group ${anvil.child.pid} survived SIGKILL`)
		})
		rpcUrl = `http://127.0.0.1:${anvilPort}`
		await waitFor("anvil", async () => (await rpc<string>(rpcUrl, "eth_chainId")) !== "", 30_000, anvil.exitReason)
		client = createPublicClient({ transport: http(rpcUrl), pollingInterval: 100 }) as PublicClient
		const co = checkout()
		await installPoseidon(rpcUrl, co)
		const announcer = JSON.parse(await readFile(join(co.contracts, "out/ERC5564Announcer.sol/ERC5564Announcer.json"), "utf8"))
		await rpc(rpcUrl, "anvil_setCode", [ANNOUNCER, announcer.deployedBytecode.object])
		const postman = privateKeyToAccount(postmanKey).address
		await rpc(rpcUrl, "anvil_setBalance", [postman, "0xde0b6b3a7640000"])
		const runDir = join(RUNS_DIR, runId)
		cleanup.push(() => rm(runDir, { recursive: true, force: true }))
		const ownerWallet = wallet(anvilKey(USER_INDEX))
		const deployer = privateKeyToAccount(anvilKey(DEPLOYER_INDEX)).address
		let sentBeforeCheck: number | undefined
		pool = await deployPoolOn({
			rpcUrl,
			chainId: CHAIN,
			deployerKey: anvilKey(DEPLOYER_INDEX),
			postman,
			mint: { to: ownerWallet.account.address, amount: 1_000n },
			runDir,
			checkBuild: async () => {
				sentBeforeCheck = await client.getTransactionCount({ address: deployer })
			},
		})
		expect(sentBeforeCheck).toBe(0)
		const config: ClientConfig = {
			rpcUrl,
			chainId: CHAIN,
			deployment: pool.deployment,
			aspUrl: `http://127.0.0.1:${aspPort}`,
			circuitsDir: co.circuits,
		}
		const aspUrl = config.aspUrl
		owner = await sepoliaPoolUser({ rpcUrl, chainId: CHAIN, deployment: pool.deployment, aspUrl, key: anvilKey(USER_INDEX) })
		stranger = await createPoolUser(config, { wallet: wallet(anvilKey(STRANGER_INDEX)) })
		await mintTestToken(wallet(anvilKey(STRANGER_INDEX)), client, pool.asset, stranger.address, 1_000n)
		asp = await startAsp()
		cleanup.push(() => asp.stop())
	}, 600_000)

	afterAll(() => cleanup.run(), 120_000)

	test("only chain 11155111 is accepted, and only a postman key starts the ASP", async () => {
		const wrong = {
			rpcUrl,
			chainId: 1 as typeof CHAIN,
			deployerKey: anvilKey(DEPLOYER_INDEX),
			mint: { to: owner.address, amount: 1n },
			runDir: "",
			checkBuild: () => {},
		}
		await expect(deployPoolOn(wrong)).rejects.toThrow("chain 1 refused")
		await expect(
			startMockAsp({
				...{ rpcUrl, chainId: CHAIN, deployment: pool.deployment, port: 1, owners: [owner.address] },
				postmanKey: generatePrivateKey(),
			}),
		).rejects.toThrow("does not hold the postman role")
	})

	test("the owner's deposit is approved and active; a stranger's stays pending", async () => {
		await owner.registerKeystore()
		await stranger.registerKeystore()
		ownerLabel = (await owner.deposit({ asset: pool.asset, value: VALUE })).label
		const deposited = await stranger.deposit({ asset: pool.asset, value: VALUE })
		strangerLabel = deposited.label
		await scannedPast(await client.getBlockNumber())
		expect(asp.approved()).toEqual([ownerLabel])
		await owner.sync()
		await stranger.sync()
		expect(owner.notes()).toMatchObject([{ label: ownerLabel, status: NoteStatus.ACTIVE }])
		expect(stranger.notes()).toMatchObject([{ label: strangerLabel, status: NoteStatus.PENDING }])
	}, 300_000)

	test("the ASP answers reads only", async () => {
		const at = (path: string, init?: RequestInit) => fetch(`${asp.url}${path}`, init)
		expect((await at("/association-set/leaves")).status).toBe(200)
		expect((await at("/admin/approve-label", { method: "POST", body: JSON.stringify({ label: "0x01" }) })).status).toBe(404)
		expect((await at("/admin/state")).status).toBe(404)
		expect((await at("/association-set/root", { method: "POST" })).status).toBe(404)
		expect((await at(`/association-set/root?entrypoint=${owner.address}`)).status).toBe(400)
		expect(asp.approved()).toEqual([ownerLabel])
	})

	test("a restarted ASP rebuilds the same set from the chain and posts nothing", async () => {
		const posts = (await rootPosts()).length
		await asp.stop()
		asp = await startAsp()
		expect(asp.approved()).toEqual([ownerLabel])
		expect(await rootPosts()).toHaveLength(posts)
	})

	test("a deposit for a registered recipient is the recipient's active note; an unregistered one is refused unsigned", async () => {
		const unregistered = privateKeyToAccount(generatePrivateKey()).address
		const nonce = await client.getTransactionCount({ address: owner.address })
		await expect(owner.depositFor({ asset: pool.asset, value: VALUE, recipient: unregistered })).rejects.toThrow(
			"has no on-chain viewing key",
		)
		expect(await client.getTransactionCount({ address: owner.address })).toBe(nonce)
		const { label } = await owner.depositFor({ asset: pool.asset, value: VALUE, recipient: stranger.address })
		await scannedPast(await client.getBlockNumber())
		expect(asp.approved()).toEqual([ownerLabel, label])
		await stranger.sync()
		expect(stranger.notes()).toContainEqual(expect.objectContaining({ label, value: VALUE, status: NoteStatus.ACTIVE }))
		await owner.sync()
		expect(owner.notes().map((n) => n.label)).not.toContain(label)
	}, 300_000)

	test("code that is not the build's is named", async () => {
		const relay = pool.deployment.relay as Address
		await rpc(rpcUrl, "anvil_setCode", [relay, await client.getCode({ address: ANNOUNCER })])
		await expect(verifyPoolCode({ rpcUrl, chainId: CHAIN, deployment: { ...pool.deployment, asset: pool.asset } })).rejects.toThrow(
			`PrivacyPoolRelay at ${relay} is not the build's`,
		)
	})
})
