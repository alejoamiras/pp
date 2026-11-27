// Everything the Forge cases read, made on the fork before Forge runs: a pool note of USDC whose label the
// ASP approved, a portal for USDC from a fresh factory, and one spend proved to that portal.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { bridgeDataV1 } from "@pp/bridge-spec"
import { createPoolUser, type PoolUser, type PreparedSpend } from "@pp/pp-env/client"
import { attachForkPoolEnv } from "@pp/pp-env/fork"
import { type Address, getAddress, type Hex, numberToHex, pad, parseAbi, toHex } from "viem"
import { ANVIL_CLIENT_VERSION, type ForkAnvil } from "./anvil.ts"
import { BUNDLE } from "./bundle.ts"
import { EVM_DIR, fixturePath } from "./forge.ts"
import { SEPOLIA_CHAIN_ID } from "./pins.ts"
import type { RunContext } from "./run.ts"
import { type ForkWallet, forkReader, freshWriter, impersonatedWriter } from "./writer.ts"

const REPO_ROOT = join(import.meta.dir, "../../..")
/** No hub exists on the fork; any field-sized recipient serves, and entries open without the hub check. */
export const HUB_PLACEHOLDER = pad(toHex("sepolia-fork hub"), { size: 32 })
const LIFETIME_CAP = 10n ** 12n
const DEPOSIT = 10_000_000n
/** The entrypoint pulls the vetting fee on top of the deposit (100 bps on V8 today); twice the deposit covers any fee. */
const MINTED = 2n * DEPOSIT
export const AMOUNT_OUT = 1_000_000n
/** `verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[8])`, the selector the vault routes 1x1 spends to. */
const VERIFIER_ABI = parseAbi(["function verifyProof(uint256[2],uint256[2][2],uint256[2],uint256[8]) view returns (bool)"])
const FIAT_TOKEN_ABI = parseAbi([
	"function masterMinter() view returns (address)",
	"function configureMinter(address minter, uint256 allowance) returns (bool)",
	"function mint(address to, uint256 amount) returns (bool)",
	"function balanceOf(address) view returns (uint256)",
])

/**
 * What `PortalFork.t.sol` reads, flat so Forge's typed JSON readers take each field: words as decimal
 * strings, the 1x1 spend's eight signal rows as one array, its note data as parallel arrays.
 */
export type Fixture = {
	block: number
	vault: Address
	usdc: Address
	inbox: Address
	factory: Address
	portal: Address
	secretHash: Hex
	/** Another valid secret hash, for the case that the proof binds the one it was made with. */
	otherSecretHash: Hex
	pA: string[]
	pB0: string[]
	pB1: string[]
	pC: string[]
	signals: string[]
	noteHints: Hex[]
	noteData: Hex[]
}

/** A random secret hash inside the field: 240 bits, never zero. */
const randomSecretHash = (): Hex => numberToHex(BigInt(`0x${crypto.getRandomValues(new Uint8Array(30)).toHex()}`) + 1n, { size: 32 })

function forgeFields(spend: PreparedSpend): Pick<Fixture, "pA" | "pB0" | "pB1" | "pC" | "signals" | "noteHints" | "noteData"> {
	const [{ pA, pB, pC, pubSignals }, , notes] = spend.args
	const words = (xs: readonly bigint[]) => xs.map((x) => x.toString())
	return {
		pA: words(pA),
		pB0: words(pB[0]),
		pB1: words(pB[1]),
		pC: words(pC),
		signals: words(pubSignals.flat()),
		noteHints: notes.map((n) => n.hint),
		noteData: notes.map((n) => n.data),
	}
}

type Artifact = { abi: unknown[]; bytecode: { object: Hex } }
const artifact = (name: string): Artifact => JSON.parse(readFileSync(join(EVM_DIR, "out", `${name}.sol`, `${name}.json`), "utf8"))

async function send(fork: ForkAnvil, hash: Promise<Hex>, what: string): Promise<void> {
	const receipt = await forkReader(fork).waitForTransactionReceipt({ hash: await hash })
	if (receipt.status !== "success") throw new Error(`${what} reverted on the fork (${receipt.transactionHash})`)
}

/** USDC for `to`, minted by a minter the real master minter configures through impersonation. */
async function mintUsdc(fork: ForkAnvil, usdc: Address, to: ForkWallet, amount: bigint): Promise<void> {
	const master = await forkReader(fork).readContract({ address: usdc, abi: FIAT_TOKEN_ABI, functionName: "masterMinter" })
	const boss = await impersonatedWriter(fork, master)
	const minter = to.account.address
	await send(
		fork,
		boss.writeContract({ address: usdc, abi: FIAT_TOKEN_ABI, functionName: "configureMinter", args: [minter, amount] }),
		"configureMinter",
	)
	await send(fork, to.writeContract({ address: usdc, abi: FIAT_TOKEN_ABI, functionName: "mint", args: [minter, amount] }), "mint")
}

/** A fresh factory for the real registry and vault, its USDC portal, and entries opened by its guardian. */
export async function bridgeSide(fork: ForkAnvil, run: RunContext): Promise<{ factory: Address; portal: Address }> {
	const { abi, bytecode } = artifact("PortalFactory")
	const guardian = await freshWriter(fork)
	const args = [run.pins.aztec.registry, HUB_PLACEHOLDER, run.pins.pool.vault, LIFETIME_CAP, guardian.account.address]
	const deploy = await guardian.deployContract({ abi, bytecode: bytecode.object, args })
	const receipt = await forkReader(fork).waitForTransactionReceipt({ hash: deploy })
	if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("PortalFactory deployment reverted on the fork")
	const factory = getAddress(receipt.contractAddress)
	const usdc = run.pins.pool.usdc
	await send(fork, guardian.writeContract({ address: factory, abi, functionName: "createPortal", args: [usdc] }), "createPortal")
	await send(fork, guardian.writeContract({ address: factory, abi, functionName: "setEntriesPaused", args: [false] }), "setEntriesPaused")
	const portal = (await forkReader(fork).readContract({ address: factory, abi, functionName: "portalOf", args: [usdc] })) as Address
	return { factory, portal: getAddress(portal) }
}

async function timed<T>(log: (line: string) => void, what: string, step: () => Promise<T>): Promise<T> {
	const t0 = performance.now()
	const out = await step()
	log(`${what} in ${Math.round(performance.now() - t0)} ms`)
	return out
}

/** A registered pool user holding one USDC note whose label the fork's mock ASP approved. */
async function poolSide(fork: ForkAnvil, run: RunContext): Promise<PoolUser> {
	const { pool } = run.pins
	const env = await timed(run.log, "mock ASP attached and synced", () =>
		attachForkPoolEnv({
			rpcUrl: fork.url,
			clientVersion: ANVIL_CLIENT_VERSION,
			chainId: SEPOLIA_CHAIN_ID,
			deployment: {
				pool: pool.vault,
				entrypoint: pool.entrypoint,
				keystore: pool.keystore,
				aspRegistry: pool.aspRegistry,
				deployBlock: pool.deployBlock,
			},
			postman: pool.postman,
			circuitsDir: run.bundle,
			circuitBundle: BUNDLE,
			runId: run.runId,
		}),
	)
	run.cleanup.push(() => env.stop())
	const wallet = await freshWriter(fork)
	await mintUsdc(fork, pool.usdc, wallet, MINTED)
	const user = await createPoolUser(env.clientConfig, { wallet })
	await timed(run.log, "keystore registered", () => user.registerKeystore())
	const { label } = await timed(run.log, "deposited", () => user.deposit({ asset: pool.usdc, value: DEPOSIT }))
	await timed(run.log, "label approved", () => env.asp.approveLabel(label))
	await timed(run.log, "user synced", () => user.sync())
	return user
}

/**
 * The deployed 1x1 verifier's own verdict on `spend`, with no vault in between. The signals go in the
 * vault router's order: the groups (nullifiers, commitments, then one word each for the roots, amount,
 * token and context) flattened as they stand.
 */
export async function verifierAccepts(fork: ForkAnvil, verifier: Address, spend: PreparedSpend): Promise<boolean> {
	const { pA, pB, pC, pubSignals } = spend.args[0]
	const signals = pubSignals.flat()
	if (signals.length !== 8) throw new Error(`a 1x1 spend has 8 public signals, got groups of ${pubSignals.map((s) => s.length)}`)
	return forkReader(fork).readContract({
		address: verifier,
		abi: VERIFIER_ABI,
		functionName: "verifyProof",
		args: [pA, pB, pC, signals as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]],
	})
}

/** Makes the fork's state and one spend proof, checks the deployed verifier accepts it, and writes the fixture. */
export async function prepare(fork: ForkAnvil, run: RunContext): Promise<{ fixture: Fixture; path: string }> {
	run.signal.throwIfAborted()
	const user = await poolSide(fork, run)
	run.signal.throwIfAborted()
	const { factory, portal } = await bridgeSide(fork, run)
	const secretHash = randomSecretHash()
	const spend = await timed(run.log, "spend proved", () =>
		user.prepareSpend({ processor: portal, data: bridgeDataV1(secretHash), asset: run.pins.pool.usdc, amountOut: AMOUNT_OUT }),
	)
	if (!(await verifierAccepts(fork, run.pins.bindings.transact1x1Verifier, spend)))
		throw new Error("the deployed 1x1 verifier rejects the spend proved with the pre-ceremony keys")
	run.log("the deployed 1x1 verifier accepts the spend")
	const block = Number(await fork.rpc<Hex>("eth_blockNumber"))
	const { pool } = run.pins
	const fixture: Fixture = {
		block,
		vault: pool.vault,
		usdc: pool.usdc,
		inbox: run.pins.bindings.inbox,
		factory,
		portal,
		secretHash,
		otherSecretHash: randomSecretHash(),
		...forgeFields(spend),
	}
	const path = fixturePath(run.runId)
	run.signal.throwIfAborted()
	mkdirSync(dirname(path), { recursive: true })
	run.cleanup.push(async () => rmSync(dirname(path), { recursive: true, force: true }))
	writeFileSync(path, JSON.stringify(fixture, null, 2))
	run.log(`fixture written: ${relative(REPO_ROOT, path)}`)
	return { fixture, path }
}
