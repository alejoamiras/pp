/**
 * What the allow-list worker does with one request, apart from the worker itself so it runs in a
 * test. It holds one snapshot, for one pair of roots, and the verified trees `LabelPathCache` keeps
 * for it. A snapshot is parsed without building a tree, and its declared roots must be the record's
 * before anything is hashed; a check then hashes only to build the tree of a label the list holds.
 */
import { type AspSnapshot, LabelPathCache, parseAspSnapshotUnverified, SnapshotError } from "@pp/label-paths"
import type { JobReply, JobRequest, ListFailure } from "./snapshot-protocol"

/** Progress replies per tree build, at most: one per percent. */
const PROGRESS_STEPS = 100

/** A list whose own fields fail is not the chain's list either; only a list longer than any tree can hold is oversized. */
function failureOf(err: unknown): ListFailure {
	if (err instanceof SnapshotError && err.code === "TooManyLeaves") return "OVERSIZED"
	if (err instanceof SnapshotError || err instanceof SyntaxError) return "MISMATCH"
	throw err
}

export function snapshotJobs(post: (reply: JobReply) => void) {
	let held: { key: string; snapshot: AspSnapshot } | null = null
	let step = -1
	const cache = new LabelPathCache({
		onProgress(hashed, total) {
			const now = Math.floor((hashed * PROGRESS_STEPS) / total)
			if (now === step) return
			step = now
			post({ kind: "progress", hashed, total })
		},
	})

	function load(req: Extract<JobRequest, { kind: "load" }>): JobReply {
		held = null
		const snapshot = parseAspSnapshotUnverified(JSON.parse(req.text))
		if (snapshot.poolRoot !== req.roots.poolRoot || snapshot.birthRoot !== req.roots.birthRoot)
			return { kind: "failed", failure: "MISMATCH" }
		held = { key: req.key, snapshot }
		return { kind: "loaded" }
	}

	function check(req: Extract<JobRequest, { kind: "check" }>): JobReply {
		if (held?.key !== req.key) return { kind: "failed", failure: "NOT_LOADED" }
		step = -1
		try {
			return { kind: "checked", result: cache.check(req.record, held.snapshot, req.label, req.origin, req.nowSec) }
		} catch (err) {
			// A list that does not build to its root is dropped: nothing more is checked against it.
			held = null
			throw err
		}
	}

	return {
		handle(req: JobRequest): void {
			let reply: JobReply
			try {
				reply = req.kind === "load" ? load(req) : check(req)
			} catch (err) {
				reply = { kind: "failed", failure: failureOf(err) }
			}
			post(reply)
		},
	}
}
