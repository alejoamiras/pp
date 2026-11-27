/**
 * Shared harness bootstrap: the L1/L2 client construction and the elapsed-timer, in one place so no
 * caller can differ silently in `proverEnabled`. Separate factories, never a combined one: callers
 * interleave L1, node and wallet creation with domain logic in their own order.
 */
import { ownedWalletStore } from "./wallet-store"
import { createAztecNodeClient } from "@aztec-labs/aztec.js/node"
import { EmbeddedWallet } from "@aztec-labs/wallets/embedded"
import {
	type Account,
	type Chain,
	createPublicClient,
	createWalletClient,
	http,
	type PublicClient,
	type Transport,
	type WalletClient,
} from "viem"

/** L1 wallet + public client pair. Generic over chain + account so viem's
 *  literal narrowing survives — `writeContract`/`deployContract` keep their
 *  optional chain/account params at every call site, no casts needed. */
export function createL1Clients<TChain extends Chain, TAccount extends Account>(opts: {
	chain: TChain
	rpcUrl: string
	account: TAccount
	/** Wraps the wallet's transport only, the one that sends; the public client stays plain. Default none. */
	wrapWalletTransport?: (transport: Transport) => Transport
}): {
	wallet: WalletClient<Transport, TChain, TAccount>
	pub: PublicClient<Transport, TChain>
} {
	// One contained cast: viem's createWalletClient widens the account through
	// parseAccount, so its inferred client type doesn't re-narrow to TAccount —
	// the runtime value IS the caller's account. Centralizing the narrow here
	// is the whole point (it replaced nine per-script casts).
	const wallet = createWalletClient({
		account: opts.account,
		chain: opts.chain,
		transport: opts.wrapWalletTransport ? opts.wrapWalletTransport(http(opts.rpcUrl)) : http(opts.rpcUrl),
	}) as unknown as WalletClient<Transport, TChain, TAccount>
	const pub = createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) })
	return { wallet, pub }
}

/** Aztec node client. Separate from the wallet factory: callers create the two in either order. */
export function createNode(nodeUrl: string): ReturnType<typeof createAztecNodeClient> {
	return createAztecNodeClient(nodeUrl)
}

/** The PXE execution hooks (`resolveCustomRequest`, `resolveTaggingSecretStrategy`, ...) a wallet can install. */
export type PxeHooks = NonNullable<NonNullable<NonNullable<Parameters<typeof EmbeddedWallet.create>[1]>["pxe"]>["hooks"]>

/** Embedded Aztec wallet. `proverEnabled` is REQUIRED — every call site states
 *  its choice visibly, so the sandbox's `false` is never a silent outlier. `sandboxKeysOnly` (every key the wallet will hold
 *  is worthless off a local network) puts the store on real disk, as run data; a wallet holding real keys needs a tmpfs
 *  `/dev/shm` and refuses to run without one. */
export function createL2Wallet(opts: {
	nodeUrl: string
	proverEnabled: boolean
	sandboxKeysOnly?: boolean
	hooks?: PxeHooks
	/** A store the caller owns and removes, such as a stack's run directory; only for sandbox keys. */
	dataDirectory?: string
}): Promise<EmbeddedWallet> {
	if (opts.dataDirectory && !opts.sandboxKeysOnly) throw new Error("a caller-owned wallet store may hold sandbox keys only")
	const dataDirectory = opts.dataDirectory ?? ownedWalletStore("wallet", { sandboxKeysOnly: opts.sandboxKeysOnly ?? false })
	return EmbeddedWallet.create(opts.nodeUrl, { pxe: { proverEnabled: opts.proverEnabled, dataDirectory, hooks: opts.hooks } })
}

/** Elapsed-minutes stopwatch — replaces each hand-rolled `t0`/`mins()` pair. */
export function stopwatch(): () => string {
	const t0 = Date.now()
	return () => `${((Date.now() - t0) / 60000).toFixed(1)}m`
}
