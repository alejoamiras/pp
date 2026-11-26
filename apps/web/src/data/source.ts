/**
 * What a build's data layer provides. `#data` resolves to the fixture world or to the adapters at
 * build time, so screens import only this interface and a stack build cannot reach fixture code.
 */
import type { WalletConnector } from "./wallet/types"

/** Latest block timestamps in seconds: chain time, which on a local chain moves only with blocks. */
export interface ChainClock {
	aztecNow(): Promise<bigint>
	l1Now(): Promise<bigint>
}

export interface DataSource {
	readonly mode: "fixtures" | "stack"
	readonly clock: ChainClock
	/** The Aztec wallet connector this build uses, loaded on first call. */
	wallet(): Promise<WalletConnector>
}
