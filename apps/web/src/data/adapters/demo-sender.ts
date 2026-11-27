/**
 * The local demo's sender. Anvil signs for its unlocked dev accounts, so a local-stack build can bridge
 * from the stack's demo address with no second wallet. It holds an address, never a key; it talks only
 * to the manifest's literal loopback L1 endpoint, with redirects refused; and it sends nothing until
 * its deployment check has passed, then only from its own address to the portal.
 */
import { type Address, getAddress, isAddressEqual } from "viem"
import { BridgeFailure, ProviderError } from "../errors"
import { type Eip1193Provider, isSendOrSign } from "../wallet/guarded-provider"
import type { DemoSender } from "./l1"

/** In every local-stack bundle and in no other: the bundle check's positive control. */
export const DEMO_SENDER_SENTINEL = "pp-demo-sender:local-stack-only"

const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"])

export interface DemoSenderOptions {
	/** The manifest's L1 endpoint, used exactly as written. */
	l1RpcUrl: string
	chainId: number
	portal: Address
	address: Address
	fetch?: typeof fetch
}

/** Before anything reaches the node: a caller that keeps a journal restores it, as after a wallet's no. */
const refused = (why: string) => new ProviderError(4001, `${DEMO_SENDER_SENTINEL}: ${why}; nothing was sent`)

function loopbackEndpoint(raw: string): string {
	const url = URL.canParse(raw) ? new URL(raw) : null
	if (url?.protocol !== "http:" || !LOOPBACK.has(url.hostname) || url.username !== "" || url.password !== "")
		throw new Error(`${DEMO_SENDER_SENTINEL}: refuses the endpoint ${raw}`)
	return raw
}

type RpcError = { code: number; message: string; data?: unknown }

function rpcOver(endpoint: string, doFetch: typeof fetch) {
	let id = 0
	return async (method: string, params: unknown): Promise<unknown> => {
		const res = await doFetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
			redirect: "error",
			credentials: "omit",
			cache: "no-store",
		})
		if (!res.ok) throw new Error(`${DEMO_SENDER_SENTINEL}: the node answered HTTP ${res.status}`)
		const body = (await res.json()) as { result?: unknown; error?: RpcError }
		if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code, data: body.error.data })
		return body.result
	}
}

export function demoSender(o: DemoSenderOptions): DemoSender {
	const rpc = rpcOver(loopbackEndpoint(o.l1RpcUrl), o.fetch ?? fetch)
	const address = getAddress(o.address)
	let checked: Promise<void> | undefined
	let passed = false
	const check = async () => {
		if (Number(await rpc("eth_chainId", [])) !== o.chainId) throw new BridgeFailure("CHAIN_MISMATCH")
		const code = await rpc("eth_getCode", [o.portal, "latest"])
		if (typeof code !== "string" || /^0x0*$/.test(code)) throw new BridgeFailure("DEPLOYMENT_MISMATCH")
		passed = true
	}
	const ready = () =>
		(checked ??= check().catch((err: unknown) => {
			checked = undefined
			throw err
		}))
	async function send(params: unknown): Promise<unknown> {
		const tx = (Array.isArray(params) ? params[0] : undefined) as { from?: unknown; to?: unknown } | undefined
		if (!passed) throw refused("the deployment is not checked yet")
		if (typeof tx?.from !== "string" || !isAddressEqual(tx.from as Address, address))
			throw refused("it sends only from its own address")
		if (typeof tx.to !== "string" || !isAddressEqual(tx.to as Address, o.portal)) throw refused("it sends only to the portal")
		return rpc("eth_sendTransaction", [tx])
	}
	const provider: Eip1193Provider = {
		async request({ method, params }) {
			if (method === "eth_accounts" || method === "eth_requestAccounts") return [address]
			if (method === "eth_sendTransaction") return send(params)
			if (isSendOrSign(method)) throw new ProviderError(4200, `${DEMO_SENDER_SENTINEL}: ${method} is not supported`)
			return rpc(method, params)
		},
	}
	return { address, ready, provider }
}
