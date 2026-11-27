import type { AllowListCode } from "./errors"
import type { RootRecord } from "./stack-types"

/**
 * Whether a registry record carries lists. The registry refuses a post with a zero pool root, so a
 * zero one is no list: `unposted` before the first post, `resetting` once the registry's poster is
 * replaced, which clears the record until the new poster's first post.
 */
export type ListPost = "posted" | "resetting" | "unposted"

export const listPost = (r: Pick<RootRecord, "poolRoot" | "sequence">): ListPost =>
	r.poolRoot !== 0n ? "posted" : r.sequence === 0n ? "unposted" : "resetting"

/** Why a record without lists checks no label; `null` for a record that carries them. */
export function noListCode(r: Pick<RootRecord, "poolRoot" | "sequence">): AllowListCode | null {
	const post = listPost(r)
	return post === "posted" ? null : post === "resetting" ? "LIST_RESETTING" : "LIST_NOT_POSTED"
}
