import { isLoopback, rpc } from "./rpc.ts"

type Call = <T>(url: string, method: string) => Promise<T>

/**
 * Refuses any node but the caller's own fork: loopback, exactly the anvil version the caller spawned,
 * and the expected chain. A mistaken URL then fails here, before the mock ASP impersonates anyone on it.
 */
export async function assertForkNode(rpcUrl: string, clientVersion: string, chainId: number, call: Call = rpc): Promise<void> {
	if (!isLoopback(rpcUrl)) throw new Error(`refusing to attach to non-loopback RPC ${new URL(rpcUrl).host}`)
	const version = await call<string>(rpcUrl, "web3_clientVersion")
	if (version !== clientVersion) throw new Error(`refusing to attach to ${version}: expected exactly ${clientVersion}`)
	const served = Number.parseInt(await call<string>(rpcUrl, "eth_chainId"), 16)
	if (served !== chainId) throw new Error(`refusing to attach to chain ${served}: expected ${chainId}`)
}
