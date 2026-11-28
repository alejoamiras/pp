/** Sepolia: the only L1 a testnet run signs on. */
export const SEPOLIA = 11155111

/** Ethereum mainnet, refused by name before anything else reads a chain id. */
export const MAINNET = 1

/** The local stack's anvil, where `--rehearse` runs every CLI with sandbox keys. */
export const LOCAL = 31337

/** Every public URL a testnet run may reach. A URL is pinned by equality with one of these, never by pattern. */
export const PINNED_URLS = {
	l1Rpc: ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.gateway.tenderly.co"],
	/** Where keyed sends go: Tenderly's gateway refuses most sends from one host, publicnode admitted every one probed. */
	l1SendRpc: ["https://ethereum-sepolia-rpc.publicnode.com"],
	aztecNode: ["https://aztec-testnet.drpc.org"],
	aspApi: ["https://api-dev.0xbow.io"],
} as const satisfies Record<string, readonly string[]>

export type PinnedKind = keyof typeof PINNED_URLS

/** Whether `url` is exactly one of `kind`'s pinned URLs. */
export const isPinned = (kind: PinnedKind, url: string): boolean => (PINNED_URLS[kind] as readonly string[]).includes(url)

/** The loopback URL of a service this host runs on `port`, such as the own pool's mock ASP or the bot's snapshot server. */
export const loopback = (port: number): string => `http://127.0.0.1:${port}`

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

/** Whether `u` is a plain-http URL on this host, where only a rehearsal's own services listen. */
export const isLoopbackUrl = (u: string): boolean =>
	URL.canParse(u) && new URL(u).protocol === "http:" && LOOPBACK_HOSTS.has(new URL(u).hostname)
