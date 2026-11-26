import { homedir } from "node:os"
import { join } from "node:path"
import type { Hex } from "viem"
import { mnemonicToAccount } from "viem/accounts"
import { anvilBin, cleanEnv } from "../tools.ts"
import type { LocalChainId } from "../types.ts"
import { claimPort } from "./ports.ts"
import { type CleanupStack, killGroup, rpc, spawnOwned, waitFor } from "./process.ts"

export const CHAIN_ID: LocalChainId = 31337
export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk"
/** Index 0 is the Aztec node's publisher and the bridge sandbox signs with 15, so pp-env stays clear of both. */
export const ANVIL_ACCOUNTS = 16
export const DEPLOYER_INDEX = 14
export const USER_INDEX = 13

export function anvilKey(index: number): Hex {
	const key = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index }).getHdKey().privateKey
	if (!key) throw new Error(`no private key for anvil index ${index}`)
	return `0x${Buffer.from(key).toString("hex")}`
}

export const LOG_DIR = join(homedir(), ".cache/pp/pp-env/logs")

/** Starts an anvil this run owns, on a registry-claimed loopback port; teardown is pushed onto `cleanup`. */
export async function startAnvil(runId: string, cleanup: CleanupStack): Promise<string> {
	const port = await claimPort(runId, "pp-env-anvil")
	// Same shape as the bridge sandbox's anvil, so an Aztec network can share it. The 7 wei base fee keeps
	// EIP-1559's per-block decrease from rounding to zero.
	const args = [
		"--host",
		"127.0.0.1",
		"--port",
		String(port),
		"--chain-id",
		String(CHAIN_ID),
		"--slots-in-an-epoch",
		"1",
		"--block-base-fee-per-gas",
		"7",
		"--accounts",
		String(ANVIL_ACCOUNTS),
		"--silent",
	]
	const anvil = spawnOwned(anvilBin(), args, join(LOG_DIR, `${runId}-anvil.log`), cleanEnv())
	cleanup.push(() => killGroup(anvil))
	const rpcUrl = `http://127.0.0.1:${port}`
	await waitFor("anvil", async () => (await rpc<string>(rpcUrl, "eth_chainId")) !== "", 30_000, anvil.exitReason)
	return rpcUrl
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"])

/**
 * Accepts only a loopback anvil on chain 31337: the deploy writes canonical code with anvil_setCode
 * and broadcasts from well-known keys, which is only safe on a throwaway local chain.
 */
export async function attachAnvil(rpcUrl: string): Promise<string> {
	const url = new URL(rpcUrl)
	if (!LOOPBACK.has(url.hostname)) throw new Error(`refusing to attach to non-loopback RPC ${url.host}`)
	const client = await rpc<string>(rpcUrl, "web3_clientVersion")
	if (!client.toLowerCase().startsWith("anvil")) throw new Error(`refusing to attach to ${client}: not anvil`)
	const chainId = Number.parseInt(await rpc<string>(rpcUrl, "eth_chainId"), 16)
	if (chainId !== CHAIN_ID) throw new Error(`refusing to attach to chain ${chainId}: expected ${CHAIN_ID}`)
	return rpcUrl
}
