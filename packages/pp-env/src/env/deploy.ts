import { copyFile, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { type Address, getAddress, type Hex, isAddress, maxUint256, type PublicClient, type WalletClient } from "viem"
import { type Checkout, PACKAGE_DIR } from "./checkout.ts"
import { withFileLock } from "./harness/lock.ts"
import { rpc } from "./harness/process.ts"
import { CANONICAL_CODE_FIXTURE, forgeLibraryFlags, POSEIDON_LIBRARIES } from "./pins.ts"
import { assertFfiDisabled, forgeBin, forgeEnv, run } from "./tools.ts"

export type PoolDeployment = {
	accessRouter: Address
	keystore: Address
	aspRegistry: Address
	pool: Address
	entrypoint: Address
	relay: Address
	postman: Address
	deployBlock: bigint
}

const FORGE_CACHE_FILE = "solidity-files-cache.json"
export const FIXTURES_DIR = join(PACKAGE_DIR, "contracts")

const CONTRACT_KEYS = {
	ACCESSROUTER: "accessRouter",
	KEYSTORE: "keystore",
	ASPREGISTRY: "aspRegistry",
	POOLVAULT: "pool",
	ENTRYPOINT: "entrypoint",
	PRIVACYPOOLRELAY: "relay",
} as const

/** Parses DeployE2ELocal's `KEY value` console lines. */
export function parseDeployOutput(stdout: string): PoolDeployment {
	const found = new Map<string, string>()
	for (const m of stdout.matchAll(/^\s*([A-Z]+) (0x[0-9a-fA-F]{40}|\d+)\s*$/gm)) if (m[1] && m[2]) found.set(m[1], m[2])
	const address = (key: string): Address => {
		const v = found.get(key)
		if (!v || !isAddress(v)) throw new Error(`deploy output has no ${key} address`)
		return getAddress(v)
	}
	const block = found.get("DEPLOYBLOCK")
	if (!block || !/^\d+$/.test(block)) throw new Error("deploy output has no decimal DEPLOYBLOCK")
	const out = { postman: address("POSTMAN"), deployBlock: BigInt(block) } as PoolDeployment
	for (const [key, field] of Object.entries(CONTRACT_KEYS)) out[field] = address(key)
	return out
}

/** Plain anvil has no CREATE2-deployed Poseidon libraries; the pool links against their canonical addresses. */
export async function installPoseidon(rpcUrl: string, co: Checkout): Promise<void> {
	const fixture = JSON.parse(await readFile(join(co.src, CANONICAL_CODE_FIXTURE), "utf8")) as Record<
		string,
		{ address: string; code: Hex }
	>
	for (const { name, address } of POSEIDON_LIBRARIES) {
		const entry = fixture[name]
		if (!entry || entry.address.toLowerCase() !== address.toLowerCase())
			throw new Error(`${CANONICAL_CODE_FIXTURE} lacks ${name} at ${address}`)
		await rpc(rpcUrl, "anvil_setCode", [address, entry.code])
	}
}

export async function deployPool(o: {
	rpcUrl: string
	co: Checkout
	deployerKey: Hex
	deployer: Address
	/** Per-run dir for forge's cache copy and broadcast logs. */
	workDir: string
	client: PublicClient
}): Promise<PoolDeployment> {
	await assertFfiDisabled(o.co.contracts)
	// forge script also writes its sensitive broadcast log under the cache path. A per-run cache dir seeded
	// with the published file keeps the shared tree read-only and still hits: the file records the
	// artifacts path, not its own.
	const cachePath = join(o.workDir, "cache")
	await mkdir(cachePath, { recursive: true })
	await copyFile(join(o.co.contracts, "cache", FORGE_CACHE_FILE), join(cachePath, FORGE_CACHE_FILE))
	const cmd = [
		forgeBin(),
		"script",
		"script/DeployE2ELocal.s.sol",
		"--sig",
		"runLocal()",
		"--root",
		o.co.contracts,
		"--rpc-url",
		o.rpcUrl,
		"--broadcast",
		"--slow",
		"--offline",
		"--cache-path",
		cachePath,
		...forgeLibraryFlags(),
	]
	const env = forgeEnv({ PRIVATE_KEY: o.deployerKey, FOUNDRY_BROADCAST: join(o.workDir, "broadcast") })
	const { stdout } = await run(cmd, { cwd: o.co.contracts, env })
	if (/^Compiling \d+ files/m.test(stdout)) throw new Error("forge recompiled the pool at deploy time: the fetched build is stale")
	const deployment = parseDeployOutput(stdout)
	if (deployment.postman !== o.deployer) throw new Error(`POSTMAN ${deployment.postman} is not the deployer ${o.deployer}`)
	for (const field of Object.values(CONTRACT_KEYS)) {
		const code = await o.client.getCode({ address: deployment[field] })
		if (!code || code === "0x") throw new Error(`${field} at ${deployment[field]} has no code on ${o.rpcUrl}`)
	}
	return deployment
}

type Artifact = { abi: readonly unknown[]; bytecode: { object: Hex } }

export async function fixtureArtifact(name: string): Promise<Artifact> {
	return JSON.parse(await readFile(join(FIXTURES_DIR, "out", `${name}.sol`, `${name}.json`), "utf8")) as Artifact
}

export async function deployFixture(
	wallet: WalletClient,
	client: PublicClient,
	name: string,
	args: readonly unknown[] = [],
): Promise<Address> {
	const { abi, bytecode } = await fixtureArtifact(name)
	if (!wallet.account) throw new Error("wallet has no account")
	const hash = await wallet.deployContract({ abi, bytecode: bytecode.object, args, account: wallet.account, chain: wallet.chain })
	const receipt = await client.waitForTransactionReceipt({ hash })
	if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`${name} deployment failed`)
	return getAddress(receipt.contractAddress)
}

const SET_ASSET_ABI = [
	{
		type: "function",
		name: "setAssetConfiguration",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "asset", type: "address" },
			{
				name: "config",
				type: "tuple",
				components: [
					{ name: "enabled", type: "bool" },
					{ name: "minAmount", type: "uint256" },
					{ name: "vettingFeeBPS", type: "uint256" },
					{ name: "maxRelayFee", type: "uint256" },
				],
			},
		],
		outputs: [],
	},
] as const

const MINT_ABI = [
	{
		type: "function",
		name: "mint",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "to", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		outputs: [],
	},
] as const

export async function mintTestToken(
	wallet: WalletClient,
	client: PublicClient,
	token: Address,
	to: Address,
	amount: bigint,
): Promise<void> {
	if (!wallet.account) throw new Error("wallet has no account")
	const hash = await wallet.writeContract({
		address: token,
		abi: MINT_ABI,
		functionName: "mint",
		args: [to, amount],
		account: wallet.account,
		chain: wallet.chain,
	})
	if ((await client.waitForTransactionReceipt({ hash })).status !== "success") throw new Error("mint failed")
}

export async function enableAsset(wallet: WalletClient, client: PublicClient, entrypoint: Address, asset: Address): Promise<void> {
	if (!wallet.account) throw new Error("wallet has no account")
	const hash = await wallet.writeContract({
		address: entrypoint,
		abi: SET_ASSET_ABI,
		functionName: "setAssetConfiguration",
		args: [asset, { enabled: true, minAmount: 1n, vettingFeeBPS: 0n, maxRelayFee: maxUint256 }],
		account: wallet.account,
		chain: wallet.chain,
	})
	if ((await client.waitForTransactionReceipt({ hash })).status !== "success") throw new Error("setAssetConfiguration failed")
}

/**
 * Builds pp-env's own fixture contracts; `offline` refuses a solc download. Even a no-op forge build
 * rewrites its cache file, so concurrent builds are serialized on a lock.
 */
export async function buildFixtures(offline: boolean): Promise<void> {
	const cmd = [forgeBin(), "build", "--root", FIXTURES_DIR, ...(offline ? ["--offline"] : [])]
	await mkdir(join(FIXTURES_DIR, "cache"), { recursive: true })
	const lock = join(FIXTURES_DIR, "cache", "pp-env-build.lock")
	const done = await withFileLock(lock, { staleMs: 300_000, waitMs: 300_000 }, () => run(cmd, { env: forgeEnv() }))
	if (!done) throw new Error(`${lock} stayed held; if no build is running, delete it`)
}

let fixturesReady: Promise<void> | undefined

/** One offline fixture build per process, shared by every env it starts. */
export function ensureFixtures(): Promise<void> {
	fixturesReady ??= buildFixtures(true).catch((err) => {
		fixturesReady = undefined
		throw err
	})
	return fixturesReady
}
