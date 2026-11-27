// Public types of `@pp/pp-env/sepolia`. Hand-written so dependents typecheck without the pool checkout;
// test/types/conformance.ts holds them equal to the implementation.
import type {
	CodeMatch,
	DeployPoolOnOptions,
	MockAsp,
	PoolCodeTargets,
	SepoliaChainId,
	SepoliaPool,
	SepoliaUserOptions,
	StartMockAspOptions,
} from "../src/sepolia/types.js"
import type { PoolUser } from "../src/client/types.js"

export type {
	CodeMatch,
	DeployPoolOnOptions,
	MockAsp,
	PoolCodeTargets,
	SepoliaChainId,
	SepoliaPool,
	SepoliaUserOptions,
	StartMockAspOptions,
} from "../src/sepolia/types.js"

/**
 * A pool user for `key` on chain 11155111, proving with the fetched checkout's circuits. The wallet is built
 * inside pp-env, so only plain data crosses to the caller. Refuses any other chain.
 */
export declare function sepoliaPoolUser(o: SepoliaUserOptions): Promise<PoolUser>

/**
 * Deploys the pinned pool to chain 11155111 through the local env's forge path, without cheat codes;
 * grants `postman` the postman role, deploys, enables and mints the six-decimal test token, and checks
 * every deployed contract's runtime code against the build. Refuses any other chain, and Poseidon
 * libraries that do not hold the canonical code.
 */
export declare function deployPoolOn(o: DeployPoolOnOptions): Promise<SepoliaPool>

/**
 * Starts a mock ASP that approves only `owner`'s deposits, posts roots with `postmanKey` and serves the
 * set through `GET` read routes alone on the claimed `port`. Refuses any other chain and a key without
 * the postman role.
 */
export declare function startMockAsp(o: StartMockAspOptions): Promise<MockAsp>

/**
 * Compares, at one block, the runtime code of every contract the pool deploy produced with the fetched
 * build, immutables masked, and returns each address checked. Refuses any other chain.
 */
export declare function verifyPoolCode(o: { rpcUrl: string; chainId: SepoliaChainId; deployment: PoolCodeTargets }): Promise<CodeMatch[]>
