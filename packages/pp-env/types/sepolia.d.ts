// Public types of `@pp/pp-env/sepolia`. Hand-written so dependents typecheck without the pool checkout;
// test/types/conformance.ts holds them equal to the implementation.
import type {
	CodeMatch,
	DeployPoolOnOptions,
	MockAsp,
	PoolCodeTargets,
	SepoliaChainId,
	SepoliaPool,
	SepoliaPoolUser,
	SepoliaUserOptions,
	StartMockAspOptions,
} from "../src/sepolia/types.js"

export type {
	CodeMatch,
	DeployPoolOnOptions,
	MockAsp,
	PoolCodeTargets,
	SepoliaChainId,
	SepoliaPool,
	SepoliaPoolUser,
	SepoliaUserOptions,
	StartMockAspOptions,
} from "../src/sepolia/types.js"

/**
 * A pool user for `key` on chain 11155111, proving with the fetched checkout's circuits. The wallet is built
 * inside pp-env, so only plain data crosses to the caller. Its `depositFor` deposits into a note another
 * registered address owns and refuses an unregistered one. Refuses any other chain.
 */
export declare function sepoliaPoolUser(o: SepoliaUserOptions): Promise<SepoliaPoolUser>

/**
 * Deploys the pinned pool to chain 11155111 through the local env's forge path, without cheat codes,
 * after building it with no key in forge's environment and running `checkBuild`; grants `postman` the
 * postman role, deploys, enables and mints the six-decimal test token, and checks every deployed
 * contract's runtime code against the build. Refuses any other chain, Poseidon libraries that do not
 * hold the canonical code, and a build that recompiles or fails `checkBuild`.
 */
export declare function deployPoolOn(o: DeployPoolOnOptions): Promise<SepoliaPool>

/**
 * Starts a mock ASP that approves only the deposits of `owners`, posts roots with `postmanKey` and serves
 * the set through `GET` read routes alone on the claimed `port`. Refuses any other chain, an empty
 * `owners` and a key without the postman role.
 */
export declare function startMockAsp(o: StartMockAspOptions): Promise<MockAsp>

/**
 * Compares, at one block, the runtime code of every contract the pool deploy produced, the test token
 * included, with the fetched build, and returns each address checked. Immutables are masked in the
 * comparison, then each must hold the targets' wiring as its getter reads it, and every transact route
 * must call its verifier's own selector. Refuses any other chain.
 */
export declare function verifyPoolCode(o: { rpcUrl: string; chainId: SepoliaChainId; deployment: PoolCodeTargets }): Promise<CodeMatch[]>
