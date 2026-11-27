import { portOwner } from "@pp/run-isolation/ports"
import { isLoopback, rpc } from "./rpc.ts"

type Call = <T>(url: string, method: string) => Promise<T>

/**
 * Refuses any node but the caller's own fork: a loopback port registered to `runId`, an anvil reporting
 * exactly `clientVersion`, on `chainId`. Another run's fork passes every other check.
 */
export async function assertForkNode(
	o: { rpcUrl: string; clientVersion: string; chainId: number; runId: string },
	call: Call = rpc,
	owner: (port: number) => string | undefined = portOwner,
): Promise<void> {
	const url = new URL(o.rpcUrl)
	if (!isLoopback(o.rpcUrl)) throw new Error(`refusing to attach to non-loopback RPC ${url.host}`)
	const holder = owner(Number(url.port))
	if (holder !== o.runId) throw new Error(`refusing to attach to port ${url.port}: registered to ${holder ?? "no run"}, not ${o.runId}`)
	const version = await call<string>(o.rpcUrl, "web3_clientVersion")
	if (!version.startsWith("anvil/") || version !== o.clientVersion)
		throw new Error(`refusing to attach to ${version}: expected exactly ${o.clientVersion}, an anvil`)
	const served = Number.parseInt(await call<string>(o.rpcUrl, "eth_chainId"), 16)
	if (served !== o.chainId) throw new Error(`refusing to attach to chain ${served}: expected ${o.chainId}`)
}
