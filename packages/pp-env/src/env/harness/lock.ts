import { closeSync, openSync, statSync, unlinkSync } from "node:fs"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function tryAcquire(lock: string, staleMs: number): boolean {
	try {
		closeSync(openSync(lock, "wx", 0o600))
		return true
	} catch {
		try {
			if (Date.now() - statSync(lock).mtimeMs > staleMs) unlinkSync(lock)
		} catch {}
		return false
	}
}

/**
 * Runs `fn` while holding an O_EXCL lock file. A lock older than `staleMs` is taken to be a dead
 * holder's and removed, so `staleMs` must exceed the longest `fn`. Returns undefined if the lock
 * stayed held for `waitMs`.
 */
export async function withFileLock<T>(
	lock: string,
	o: { staleMs: number; waitMs: number },
	fn: () => Promise<T> | T,
): Promise<{ value: T } | undefined> {
	const deadline = Date.now() + o.waitMs
	while (!tryAcquire(lock, o.staleMs)) {
		if (Date.now() >= deadline) return undefined
		await sleep(100)
	}
	try {
		return { value: await fn() }
	} finally {
		try {
			unlinkSync(lock)
		} catch {}
	}
}
