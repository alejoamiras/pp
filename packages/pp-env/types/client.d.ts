// Public types of `@pp/pp-env/client`. Hand-written so dependents typecheck without the pool checkout;
// test/types/conformance.ts holds them equal to the implementation.
import type { Address, Hex } from "viem"
import type { ClientConfig, LocalWallet, PoolUser, SecretDerivationTypedData } from "../src/client/types.js"

export {
	POOL_VAULT_ERRORS_ABI,
	POOL_VAULT_EVENTS_ABI,
	POOL_VAULT_TRANSACT_ABI,
	TRANSACT_ABI,
	type TransactArgs,
} from "../src/client/abi.js"
export type * from "../src/client/types.js"

/** Part of the signed hash, and so of every derived key. */
export declare const SECRET_DERIVATION_PURPOSE: string

/** The EIP-712 payload whose signature roots a user's protocol keys. */
export declare function secretDerivationTypedData(signer: Address): SecretDerivationTypedData

/**
 * A pool user whose keys derive from `signature`, or from `wallet` signing the secret-derivation
 * payload; a signature that is not the wallet's is refused. Spends are proved locally with the
 * circuits in `config.circuitsDir`.
 */
export declare function createPoolUser(config: ClientConfig, o: { wallet: LocalWallet; signature?: Hex }): Promise<PoolUser>
