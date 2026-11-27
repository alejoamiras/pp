/**
 * A bare local anvil (chain 31337) one rehearsal case owns, a miner the case drives by hand, and the
 * bridge's own PortalFactory from the forge build on it. The factory's registry and rollup are one-word
 * stubs: its constructor only stores what they return, and a pause reads nothing but the factory.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { claimPort } from "@pp/run-isolation/ports"
import { type CleanupStack, killGroup, type OwnedChild, spawnOwned } from "@pp/run-isolation/process"
import { resolveAnvil } from "@pp/sepolia-fork/src/anvil.ts"
import { httpRpc, type Rpc } from "@pp/sepolia-fork/src/rpc.ts"
import { type Abi, type Address, createPublicClient, createWalletClient, type Hash, type Hex, http, numberToHex, pad, toHex } from "viem"
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts"
import { forgeArtifact } from "../creation"
import { ANVIL_MNEMONIC } from "../guards"
import { LOCAL } from "../network"

/** The private key of anvil's well-known account `index`. */
export const anvilKey = (index: number): Hex =>
	toHex(mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index }).getHdKey().privateKey as Uint8Array)

export const STUB_REGISTRY: Address = "0x000000000000000000000000000000000000a001"
export const STUB_ROLLUP: Address = "0x000000000000000000000000000000000000a002"
/** What the stub rollup answers to every call: its Inbox and Outbox are address 1, its version 1. */
export const STUB_ROLLUP_WORD = 1n

/** Runtime code that returns `word` to any call: PUSH32 word, MSTORE at 0, RETURN 32 bytes. */
const returnsWord = (word: Hex): Hex => `0x7f${word.slice(2)}60005260206000f3`

export type LocalChain = { url: string; rpc: Rpc; owned: OwnedChild }

export type ChainOptions = { runId: string; service: string; dir: string; cleanup: CleanupStack }

/** Anvil 1.7.1 on a port claimed under `runId`, as its own process group, with its teardown on `cleanup`. */
export async function startLocalAnvil(o: ChainOptions): Promise<LocalChain> {
	const port = await claimPort(o.runId, o.service)
	const owned = spawnOwned(
		resolveAnvil(),
		["--host", "127.0.0.1", "--port", String(port), "--chain-id", String(LOCAL)],
		join(o.dir, `${o.service}.log`),
		{ PATH: process.env.PATH ?? "", HOME: o.dir },
		{ release: [{ port, service: o.service, owner: o.runId }] },
	)
	o.cleanup.push(async () => {
		if (!(await killGroup(owned))) throw new Error(`${o.service}'s process group ${owned.child.pid} survived SIGKILL`)
	})
	const url = `http://127.0.0.1:${port}`
	const rpc = httpRpc(url)
	for (const deadline = Date.now() + 60_000; ; ) {
		if (owned.hasExited()) throw new Error(`${o.service} exited before it served: ${owned.exitReason()}`)
		const id = await rpc<Hex>("eth_chainId").catch(() => undefined)
		if (id !== undefined && Number(id) === LOCAL) return { url, rpc, owned }
		if (id !== undefined) throw new Error(`${o.service} serves chain ${Number(id)}, not ${LOCAL}`)
		if (Date.now() > deadline) throw new Error(`${o.service} did not serve within 60 s`)
		await Bun.sleep(100)
	}
}

export type Miner = {
	/** Resolves once no block is being mined and none will be until {@link Miner.resume}. */
	pause(): Promise<void>
	resume(): void
	/** Every later block's base fee, or anvil's own once undefined: a fee spike that outlasts the case. */
	holdBaseFee(fee: bigint | undefined): void
	/** Stops mining; rejects with the first failed mine, if any. */
	stop(): Promise<void>
}

/** Turns automine off and mines one block every `intervalMs` while not paused. */
export async function startMiner(rpc: Rpc, intervalMs = 250): Promise<Miner> {
	await rpc("evm_setAutomine", [false])
	let running = true
	let mining = true
	let hold: bigint | undefined
	let failure: unknown
	let current: Promise<void> = Promise.resolve()
	const tick = async () => {
		if (hold !== undefined) await rpc("anvil_setNextBlockBaseFeePerGas", [numberToHex(hold)])
		await rpc("evm_mine")
	}
	const loop = (async () => {
		while (running && failure === undefined) {
			if (mining) {
				current = tick().catch((e) => {
					failure = e
				})
				await current
			}
			await Bun.sleep(intervalMs)
		}
	})()
	return {
		async pause() {
			mining = false
			await current
		},
		resume() {
			mining = true
		},
		holdBaseFee(fee) {
			hold = fee
		},
		async stop() {
			running = false
			await loop
			if (failure !== undefined) throw failure
		},
	}
}

/** viem's chain for the local anvil behind `url`. */
export const localChain = (url: string) => ({
	id: LOCAL,
	name: "local",
	nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
	rpcUrls: { default: { http: [url] } },
})

export type Factory = { factory: Address; tx: Hash; block: bigint }

/**
 * Plants the stub registry and rollup, then deploys PortalFactory from `contracts/bridge/evm/out` with
 * `guardian` as its owner, entries paused as the constructor leaves them. Automine must be on.
 */
export async function deployFactory(chain: LocalChain, deployerKey: Hex, guardian: Address): Promise<Factory> {
	await chain.rpc("anvil_setCode", [STUB_REGISTRY, returnsWord(pad(STUB_ROLLUP))])
	await chain.rpc("anvil_setCode", [STUB_ROLLUP, returnsWord(numberToHex(STUB_ROLLUP_WORD, { size: 32 }))])
	const artifact = JSON.parse(readFileSync(forgeArtifact("PortalFactory"), "utf8")) as { abi: Abi; bytecode: { object: Hex } }
	const def = localChain(chain.url)
	const wallet = createWalletClient({ account: privateKeyToAccount(deployerKey), chain: def, transport: http(chain.url) })
	const tx = await wallet.deployContract({
		abi: artifact.abi,
		bytecode: artifact.bytecode.object,
		// registry, L2 hub, pool, lifetime cap, guardian: the hub and pool are never called on this path.
		args: [STUB_REGISTRY, pad("0x01"), "0x000000000000000000000000000000000000a003", 1n, guardian],
	})
	const receipt = await createPublicClient({ chain: def, transport: http(chain.url) }).waitForTransactionReceipt({ hash: tx })
	if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`the PortalFactory deploy failed (${tx})`)
	return { factory: receipt.contractAddress, tx, block: receipt.blockNumber }
}
