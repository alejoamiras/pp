import { realpathSync } from "node:fs"
import { copyFile, mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { type Address, getAddress, type Hex, isAddress, maxUint256, type PublicClient, type WalletClient } from "viem"
import { type Checkout, PACKAGE_DIR } from "./checkout.ts"
import type { PoolDeployment } from "./types.ts"
import { withFileLock } from "@pp/run-isolation/lock"
import { rpc } from "./harness/rpc.ts"
import { CANONICAL_CODE_FIXTURE, forgeLibraryFlags, POSEIDON_LIBRARIES } from "./pins.ts"
import { assertFfiDisabled, forgeBin, forgeEnv, run } from "./tools.ts"

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

const RECOMPILED = /^Compiling \d+ files/m

/**
 * Builds the pool with no key in forge's environment, runs `checkBuild`, and only then runs the keyed
 * `DeployE2ELocal` script, which must find nothing left to compile.
 * @throws Error when either forge run compiles, `checkBuild` throws, the script fails, or a deployed
 * contract has no code; nothing is broadcast when the first build compiles or `checkBuild` throws
 */
export async function deployPool(o: {
	rpcUrl: string
	co: Checkout
	deployerKey: Hex
	deployer: Address
	/** Per-run dir for forge's cache copy and broadcast logs. */
	workDir: string
	client: PublicClient
	/** Runs between the keyless build and the keyed script; a throw stops the deploy there. */
	checkBuild?: () => void | Promise<void>
	/**
	 * Take each transaction's gas limit from the node's `eth_estimateGas` instead of forge's own replay,
	 * which prices gas at the pinned `evm_version` and so underprices a chain on a later fork.
	 */
	skipSimulation?: boolean
}): Promise<PoolDeployment> {
	await assertFfiDisabled(o.co.contracts)
	// forge script also writes its sensitive broadcast log under the cache path. A per-run cache dir seeded
	// with the published file keeps the shared tree read-only and still hits: the file records the
	// artifacts path, not its own.
	const cachePath = join(o.workDir, "cache")
	await mkdir(cachePath, { recursive: true })
	await copyFile(join(o.co.contracts, "cache", FORGE_CACHE_FILE), join(cachePath, FORGE_CACHE_FILE))
	const shared = ["--root", o.co.contracts, "--offline", "--cache-path", cachePath, ...forgeLibraryFlags()]
	// The script compiles whatever the cache misses and then broadcasts, so the build runs keyless first;
	// `--skip test` is the fetch's own build, which the published cache records.
	const build = await run([forgeBin(), "build", "--skip", "test", ...shared], { cwd: o.co.contracts, env: forgeEnv() })
	if (RECOMPILED.test(build.stdout)) throw new Error("forge recompiled the pool before the deploy: the fetched build is stale")
	await o.checkBuild?.()
	const cmd = [
		forgeBin(),
		"script",
		"script/DeployE2ELocal.s.sol",
		"--sig",
		"runLocal()",
		"--rpc-url",
		o.rpcUrl,
		"--broadcast",
		"--slow",
		...(o.skipSimulation ? ["--skip-simulation"] : []),
		...shared,
	]
	const env = forgeEnv({ PRIVATE_KEY: o.deployerKey, FOUNDRY_BROADCAST: join(o.workDir, "broadcast") })
	const { stdout } = await run(cmd, { cwd: o.co.contracts, env })
	if (RECOMPILED.test(stdout)) throw new Error("forge recompiled the pool at deploy time: the fetched build is stale")
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

/** The fixtures' Solidity imports: prefix, npm package, and the package subdirectory the prefix names. */
const FIXTURE_DEPS = [
	{ prefix: "@openzeppelin/contracts/", pkg: "@openzeppelin/contracts", sub: "" },
	{ prefix: "forge-std/", pkg: "forge-std", sub: "src" },
] as const

/**
 * A package manager may link a dependency from anywhere, such as an isolated store outside the
 * package, and solc resolves imports to their real paths. So each dependency is found the way Bun
 * finds it, then remapped to its real directory and allowed by name: nothing assumes a layout.
 * Forge takes remappings as flags but allowed paths only from config, hence the env var.
 */
export function fixtureForge(dir: string = FIXTURES_DIR): { args: string[]; env: Record<string, string> } {
	const deps = FIXTURE_DEPS.map(({ prefix, pkg, sub }) => {
		const root = realpathSync(dirname(Bun.resolveSync(`${pkg}/package.json`, dir)))
		return { root, remapping: `${prefix}=${join(root, sub)}/` }
	})
	return {
		args: ["--root", dir, ...deps.flatMap((d) => ["--remappings", d.remapping])],
		env: forgeEnv({ FOUNDRY_ALLOW_PATHS: JSON.stringify(deps.map((d) => d.root)) }),
	}
}

/**
 * Runs `fn` holding the fixture project's lock. Even a no-op forge build rewrites its cache file, so
 * every forge command on the project goes through here. The lock sits outside `cache` and `out`,
 * where `forge clean` cannot remove it from under its holder.
 */
export async function withFixtureLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
	const lock = join(dir, ".forge.lock")
	const done = await withFileLock(lock, { staleMs: 300_000, waitMs: 300_000 }, fn)
	if (!done) throw new Error(`${lock} stayed held; if no forge command is running, delete it`)
	return done.value
}

/** Builds pp-env's own fixture contracts; `offline` refuses a solc download. */
export async function buildFixtures(offline: boolean, dir: string = FIXTURES_DIR): Promise<void> {
	const { args, env } = fixtureForge(dir)
	const cmd = [forgeBin(), "build", ...args, ...(offline ? ["--offline"] : [])]
	await withFixtureLock(dir, () => run(cmd, { env }))
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
