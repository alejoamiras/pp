/**
 * The anvil indices the demo stack signs from, and the demo sender's address, as plain values: the web
 * build's config loads this module under Node, which resolves neither the sandbox's extensionless
 * imports nor pp-env's fetched pool checkout. `accounts.test.ts` pins the derived values, the demo
 * sender's address and the harness index. `POOL_DEPLOYER_INDEX` is not pinned: pp-env's
 * `DEPLOYER_INDEX` sits only on its root barrel, which a job without the checkout cannot load.
 */
import type { Address } from "viem"

/** The demo's pool user: registered, holding two approved notes. */
export const SEED_USER_INDEX = 13
/** The demo's separate Ethereum sender: a bridge from the note owner's own address is refused. */
export const DEMO_SENDER_INDEX = 12
/** The demo sender's address, the one value of it a page build may carry. */
export const DEMO_SENDER_ADDRESS: Address = "0xFABB0ac9d68B0B445fB7357272Ff202C5651694a"
/** pp-env's default deployer; bridge-core's harness and actors sit at 15 and from 1 up. */
export const POOL_DEPLOYER_INDEX = 14
/** The bridge's owner and guardian: bridge-core's harness index, below pp-env's deployer and above the actors. */
export const BRIDGE_DEPLOYER_INDEX = 15
