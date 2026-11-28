import { BridgeFailure } from "./errors"

/**
 * `load` run once and shared while it runs and after it resolves. A rejection is dropped, so the next
 * call runs `load` again. Whether a chunk the browser failed to fetch is fetched again is the
 * browser's choice; `PAGE_LOAD_FAILED`'s sentence says to reload.
 */
export function loadOnce<T>(load: () => Promise<T>): () => Promise<T> {
	let pending: Promise<T> | undefined
	return () => {
		if (pending !== undefined) return pending
		const attempt: Promise<T> = load().catch((err: unknown) => {
			if (pending === attempt) pending = undefined
			throw err
		})
		pending = attempt
		return attempt
	}
}

/**
 * A chunk import whose failure reads `PAGE_LOAD_FAILED`. Browsers word a failed chunk fetch
 * differently, so the code comes from where the import is, never from the error's message, which
 * goes only to the console. Pass the bare `import()`: a failure of what runs after it keeps its own
 * error.
 */
export const importChunk = <M>(chunk: Promise<M>): Promise<M> =>
	chunk.catch((err: unknown) => {
		console.error("[pp] a part of the page failed to load", err)
		throw new BridgeFailure("PAGE_LOAD_FAILED")
	})
