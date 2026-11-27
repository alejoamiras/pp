/** The local stack is chain 31337 over a loopback L1 RPC; any other chain is treated as a public one. */
const LOCAL_CHAIN_ID = 31337
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"])

/** Whether `m` names the local stack. An RPC URL that does not parse names none. */
export function isLocalStack(m: { chainId: number; l1Rpc: string }): boolean {
	if (m.chainId !== LOCAL_CHAIN_ID) return false
	try {
		return LOOPBACK_HOSTS.has(new URL(m.l1Rpc).hostname)
	} catch {
		return false
	}
}
