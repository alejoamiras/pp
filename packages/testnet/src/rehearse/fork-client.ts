import { createPublicClient, http } from "viem"

/**
 * A read client on a Sepolia fork. A fork holds copies of contracts other parties deploy, so CCIP-read is
 * off: an `OffchainLookup` revert from one would otherwise send the client to a URL that party chose.
 */
export const forkReads = (url: string) => createPublicClient({ transport: http(url), ccipRead: false })
