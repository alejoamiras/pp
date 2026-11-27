import { type ClientTiming, LOCAL_TIMING, PUBLIC_CHAIN_TIMING } from "@pp/bridge-core"
import { isLocalStack } from "../local-chain"

/** The bridge client's receipt wait: the local stack's two minutes there, a public chain's ten anywhere else. */
export const bridgeTiming = (m: { chainId: number; l1Rpc: string }): ClientTiming => (isLocalStack(m) ? LOCAL_TIMING : PUBLIC_CHAIN_TIMING)
