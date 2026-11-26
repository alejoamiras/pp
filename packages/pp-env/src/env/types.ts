// The environment's public types. No SDK import, so dependents typecheck without the pool checkout.
import type { Address, Hex } from "viem"
import type { ClientConfig, PoolUser, PreparedSpend } from "../client/types.ts"

/** Anvil's default chain, which the Aztec local network also deploys its rollup to. */
export type LocalChainId = 31337

export type PoolDeployment = {
	accessRouter: Address
	keystore: Address
	aspRegistry: Address
	pool: Address
	entrypoint: Address
	relay: Address
	postman: Address
	deployBlock: bigint
}

export type StartPoolEnvOptions = {
	/** Attach to this loopback anvil instead of starting one; stop() then leaves it running. */
	rpcUrl?: string
	/** Anvil index of the deployer, who is also the ASP postman. */
	deployerIndex?: number
	/** Names the run's port rows, logs and run dir; defaults to a fresh id. */
	runId?: string
	/**
	 * Default true: SIGINT and SIGTERM run stop() and then re-raise. Pass false when the caller
	 * owns one ordered teardown and calls stop() itself.
	 */
	signals?: boolean
}

export interface PoolEnv {
	runId: string
	rpcUrl: string
	chainId: LocalChainId
	deployment: PoolDeployment
	asset: Address
	deployerIndex: number
	asp: {
		url: string
		/** Adds the label's leaf, publishes the new root on chain, and returns that root. */
		approveLabel(label: bigint): Promise<bigint>
	}
	/** What the user side needs to reach this pool. */
	clientConfig: ClientConfig
	/** A pool user on anvil account `accountIndex`; see `createPoolUser` for `signature`. */
	createUser(o: { accountIndex: number; signature?: Hex }): Promise<PoolUser>
	/** Mints the test token, which has an open mint. */
	mint(to: Address, amount: bigint): Promise<void>
	/** Deploys a StubProcessor bound to this pool and asset. */
	deployStub(): Promise<Address>
	/** Submits a prepared spend through `stub` from anvil account `fromIndex`. */
	submitViaStub(stub: Address, spend: PreparedSpend, fromIndex: number): Promise<Hex>
	/** Idempotent; also runs on SIGINT and SIGTERM unless started with `signals: false`. */
	stop(): Promise<void>
}
