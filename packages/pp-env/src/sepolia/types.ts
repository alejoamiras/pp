// The Sepolia entry's public types. No SDK import, so dependents typecheck without the pool checkout.
import type { Address, Hex } from "viem"
import type { CircuitBundleName, ClientDeployment, PoolUser } from "../client/types.ts"
import type { PoolDeployment } from "../env/types.ts"

/** Sepolia's chain id. Nothing in `@pp/pp-env/sepolia` accepts another chain, mainnet least of all. */
export type SepoliaChainId = 11155111

export type DeployPoolOnOptions = {
	/** An endpoint serving chain 11155111: Sepolia, or a loopback anvil the caller runs with that id. */
	rpcUrl: string
	chainId: SepoliaChainId
	/** Becomes every pool role: admin, ops admin, upgrader, pauser, entrypoint manager and first postman. */
	deployerKey: Hex
	/** Also granted the ASP registry's postman role, so the ASP's key need not hold the admin's. */
	postman?: Address
	/** The six-decimal open-mint test token's first mint. */
	mint: { to: Address; amount: bigint }
	/** The run's own directory: forge's cache copy and broadcast logs land here. */
	runDir: string
	/**
	 * Runs once the pool and the fixtures are built with no key in reach and before `deployerKey` reaches
	 * any child or signs: the caller compares the built artifacts with its pins here. A throw stops the
	 * deploy with nothing sent.
	 */
	checkBuild: () => void | Promise<void>
	log?: (line: string) => void
}

export type SepoliaPool = {
	deployment: PoolDeployment
	/** The test token, enabled on the entrypoint. */
	asset: Address
	/** Wei the deployer spent across every transaction, measured as its balance change. */
	spentWei: bigint
}

/** The deployed contracts whose runtime code `verifyPoolCode` compares with the fetched build. */
export type PoolCodeTargets = Pick<PoolDeployment, "accessRouter" | "keystore" | "aspRegistry" | "pool" | "entrypoint" | "relay"> & {
	/** The test token `deployPoolOn` deploys, compared with pp-env's own `TestToken` build. */
	asset: Address
}

/** One address whose code matched the build: a contract, a proxy, its implementation, a verifier or a linked library. */
export type CodeMatch = { name: string; address: Address }

export type StartMockAspOptions = {
	rpcUrl: string
	chainId: SepoliaChainId
	/**
	 * Holds the registry's postman role. It also seeds the X25519 key deposits encrypt their labels to,
	 * so a restarted ASP decrypts every deposit the last one approved and needs no stored state.
	 */
	postmanKey: Hex
	deployment: Pick<PoolDeployment, "accessRouter" | "aspRegistry" | "pool" | "entrypoint" | "deployBlock">
	/** A loopback port the caller already claimed. */
	port: number
	/** Only this depositor's deposits are approved. */
	owner: Address
	/** Default 12 000 ms, one Sepolia slot. */
	pollMs?: number
	log?: (line: string) => void
}

export interface MockAsp {
	url: string
	/** The X25519 key served at `/public-key`. */
	publicKey: Hex
	/** Labels whose leaves the registry's latest root commits to, in tree order. */
	approved(): readonly bigint[]
	/** The last block every deposit through which has been read and, if the owner's, approved. */
	scanned(): bigint
	/** Stops polling, lets a root post in flight finish, then closes the server. Idempotent. */
	stop(): Promise<void>
}

/** A Sepolia pool user that can also deposit for another registered address. */
export type SepoliaPoolUser = PoolUser & {
	/**
	 * Deposits `value` of `asset` from this user's wallet into a note `recipient` owns, encrypted to the
	 * viewing key `recipient` registered in the keystore. The ASP sees this user as the depositor.
	 * @throws Error naming the recipient when it has no registered viewing key; nothing is sent then
	 */
	depositFor(p: { asset: Address; value: bigint; recipient: Address }): Promise<{ label: bigint; commitment: bigint }>
}

export type SepoliaUserOptions = {
	rpcUrl: string
	chainId: SepoliaChainId
	deployment: ClientDeployment
	aspUrl: string
	/** The depositor's L1 key; its address owns the pool user's notes. */
	key: Hex
	/** Default `ceremony`, the keys the pinned build deploys. */
	circuitBundle?: CircuitBundleName
}
