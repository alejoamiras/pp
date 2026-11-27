import { portOwner } from "@pp/run-isolation/ports"
import { rpc } from "./rpc.ts"

type Call = <T>(url: string, method: string) => Promise<T>

/**
 * Refuses any node but the caller's own fork: a port on 127.0.0.1 registered to `runId`, an anvil reporting
 * exactly `clientVersion`, on `chainId`. Another run's fork passes every other check. Only 127.0.0.1: the
 * registry claims a port number by probing that address, so `[::1]` or `localhost` at the same port can be
 * a different listener.
 */
export async function assertForkNode(
	o: { rpcUrl: string; clientVersion: string; chainId: number; runId: string },
	call: Call = rpc,
	owner: (port: number) => string | undefined = portOwner,
): Promise<void> {
	const url = new URL(o.rpcUrl)
	if (url.hostname !== "127.0.0.1") throw new Error(`refusing to attach to ${url.host}: a fork must listen on 127.0.0.1`)
	const holder = owner(Number(url.port))
	if (holder === undefined || holder !== o.runId)
		throw new Error(`refusing to attach to port ${url.port}: registered to ${holder ?? "no run"}, not ${o.runId}`)
	const version = await call<string>(o.rpcUrl, "web3_clientVersion")
	if (!version.startsWith("anvil/") || version !== o.clientVersion)
		throw new Error(`refusing to attach to ${version}: expected exactly ${o.clientVersion}, an anvil`)
	const served = Number.parseInt(await call<string>(o.rpcUrl, "eth_chainId"), 16)
	if (served !== o.chainId) throw new Error(`refusing to attach to chain ${served}: expected ${o.chainId}`)
}
