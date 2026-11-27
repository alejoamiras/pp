import type { LivePost } from "./live"
import type { SnapshotBook } from "./server"

/**
 * This process's own checkpointed posts as readiness sees them: ready once `/latest` serves the newest.
 * A failed read after a post can leave its snapshot unserved while a later post becomes current.
 */
export function ownPosts(book: SnapshotBook) {
	let newest: LivePost | undefined
	return {
		posted(p: LivePost): void {
			newest = p
		},
		/** True until this process has checkpointed a post. */
		none: (): boolean => newest === undefined,
		/** The newest own post when `/latest` serves exactly it. */
		served: (): LivePost | undefined => (newest && book.servesLatest(newest.sequence) ? newest : undefined),
	}
}
