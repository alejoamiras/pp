import { randomBytes } from "node:crypto"
import { closeSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeSync } from "node:fs"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The calls that reclaim a stale lock, passed in so a test can stall one where the scheduler won't on demand. */
export interface LockFs {
	stat(path: string): { mtimeMs: number }
	rename(from: string, to: string): void
	link(existing: string, path: string): void
	unlink(path: string): void
}

const HOST: LockFs = {
	stat: (path) => statSync(path),
	rename: (from, to) => renameSync(from, to),
	link: (existing, path) => linkSync(existing, path),
	unlink: (path) => unlinkSync(path),
}

const isStale = (path: string, staleMs: number, fs: LockFs) => Date.now() - fs.stat(path).mtimeMs > staleMs

/**
 * Removes a dead holder's lock. Another reclaimer may replace the lock between the stat and the
 * removal, so the lock is moved to a name only this call uses and judged again there; one that turns
 * out live, or cannot be judged, goes back under its name, unless an acquirer took the name in that gap.
 */
function reclaim(lock: string, staleMs: number, token: string, fs: LockFs): void {
	if (!isStale(lock, staleMs, fs)) return
	const aside = `${lock}.${token.replace(":", "-")}.reclaim`
	fs.rename(lock, aside)
	let stale = false
	try {
		stale = isStale(aside, staleMs, fs)
	} catch {}
	try {
		if (!stale) fs.link(aside, lock)
	} finally {
		fs.unlink(aside)
	}
}

function tryAcquire(lock: string, staleMs: number, token: string, fs: LockFs): boolean {
	let fd: number
	try {
		fd = openSync(lock, "wx", 0o600)
	} catch {
		try {
			reclaim(lock, staleMs, token, fs)
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
	fs: LockFs = HOST,
): Promise<{ value: T } | undefined> {
	const token = `${process.pid}:${randomBytes(8).toString("hex")}`
	const deadline = Date.now() + o.waitMs
	while (!tryAcquire(lock, o.staleMs, token, fs)) {
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
