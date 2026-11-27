// Public types of `@pp/pp-env/fork`. Hand-written so dependents typecheck without the pool checkout;
// test/types/conformance.ts holds them equal to the implementation.
import type { AttachForkOptions, ForkPoolEnv } from "../src/env/types.js"

export type { AttachForkOptions, ForkPoolEnv } from "../src/env/types.js"

/**
 * Attaches to the caller's fork of a live chain and starts a mock ASP that impersonates the registry's
 * postman there. Refuses a non-loopback node, any `web3_clientVersion` but `clientVersion`, and any
 * other chain, before anything starts.
 */
export declare function attachForkPoolEnv(o: AttachForkOptions): Promise<ForkPoolEnv>
