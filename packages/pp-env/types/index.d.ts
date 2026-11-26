// Public types of `@pp/pp-env`. Hand-written so dependents typecheck without the pool checkout;
// test/types/conformance.ts holds them equal to the implementation.
import type { Address, Hex, PublicClient } from "viem"
import type { LocalWallet, PreparedSpend } from "../src/client/types.js"
import type { LocalChainId, PoolEnv, StartPoolEnvOptions } from "../src/env/types.js"

export * from "./client.js"
export type { LocalChainId, PoolDeployment, PoolEnv, StartPoolEnvOptions } from "../src/env/types.js"
export { STUB_PROCESSOR_ABI } from "../src/env/stub-abi.js"

export declare const CHAIN_ID: LocalChainId
/** Anvil account that deploys the pool and posts ASP roots. */
export declare const DEPLOYER_INDEX: 14
/** Anvil account the tests use as the pool user. */
export declare const USER_INDEX: 13

/** Private key of anvil account `index` on the well-known test mnemonic. */
export declare function anvilKey(index: number): Hex

/** Brings up the pool on a local anvil; anything started is torn down again if a later step fails. */
export declare function startPoolEnv(o?: StartPoolEnvOptions): Promise<PoolEnv>

/** Submits `spend.args` through `stub` from `wallet`; the proof binds the processor, not the sender. */
export declare function submitViaStub(wallet: LocalWallet, client: PublicClient, stub: Address, spend: PreparedSpend): Promise<Hex>
