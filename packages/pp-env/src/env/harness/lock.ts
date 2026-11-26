import { closeSync, openSync, statSync, unlinkSync, utimesSync } from "node:fs"

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
 * Runs `fn` while holding an O_EXCL lock file. A lock whose mtime is older than `staleMs` is taken
 * to be a dead holder's and removed; a live holder touches it meanwhile, so `fn` may outlast
 * `staleMs` as long as it yields to the event loop. Returns undefined if the lock stayed held for `waitMs`.
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
	const heartbeat = setInterval(() => {
		try {
			const now = new Date()
			utimesSync(lock, now, now)
		} catch {}
	}, o.staleMs / 3)
	heartbeat.unref()
	try {
		return { value: await fn() }
	} finally {
		clearInterval(heartbeat)
		try {
			unlinkSync(lock)
		} catch {}
	}
}
