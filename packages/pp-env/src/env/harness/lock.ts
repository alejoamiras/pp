import { randomBytes } from "node:crypto"
import { closeSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function tryAcquire(lock: string, staleMs: number, token: string): boolean {
	let fd: number
	try {
		fd = openSync(lock, "wx", 0o600)
	} catch {
		try {
			if (Date.now() - statSync(lock).mtimeMs > staleMs) unlinkSync(lock)
		} catch {}
		return false
	}
	try {
		writeSync(fd, token)
	} finally {
		closeSync(fd)
	}
	return true
}

/** False once another process has reclaimed the lock: it is theirs to renew and remove. */
function stillHolds(lock: string, token: string): boolean {
	try {
		return readFileSync(lock, "utf8") === token
	} catch {
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
	const token = `${process.pid}:${randomBytes(8).toString("hex")}`
	const deadline = Date.now() + o.waitMs
	while (!tryAcquire(lock, o.staleMs, token)) {
		if (Date.now() >= deadline) return undefined
		await sleep(100)
	}
	const heartbeat = setInterval(() => {
		if (!stillHolds(lock, token)) return
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
		if (stillHolds(lock, token)) {
			try {
				unlinkSync(lock)
			} catch {}
		}
	}
}
