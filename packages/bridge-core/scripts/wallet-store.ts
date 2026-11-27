import { createHash } from "node:crypto"
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statfsSync } from "node:fs"
import { constants as osConstants, homedir } from "node:os"
import { join } from "node:path"
import { pidNamespace, startTime } from "@pp/run-isolation/process-group"

const owned: string[] = []
const TMPFS_MAGIC = 0x01021994
const LABEL = /^[a-z][a-z0-9]*$/

/** Some hosts mount `/dev/shm` as a plain directory on disk, so existing is not enough. */
function isTmpfs(path: string): boolean {
	try {
		return statfsSync(path).type === TMPFS_MAGIC
	} catch {
		return false
	}
}

const diskRoot = () => join(homedir(), ".cache", "pp")

/**
 * Where a store is created. Public sandbox keys go to real disk under `~/.cache/pp`, like any run's
 * data, so a store a killed run leaves pins no RAM. Real keys go to the RAM-backed `shm`, for secrecy
 * (never written to disk), not for speed.
 * @throws for real keys when `shm` is not a tmpfs.
 */
export function storeRoot(opts: { sandboxKeysOnly: boolean; shm?: string }): string {
	if (opts.sandboxKeysOnly) return diskRoot()
	const shm = opts.shm ?? "/dev/shm"
	if (isTmpfs(shm)) return shm
	throw new Error(
		`${shm} is not a tmpfs, and a wallet store holding real keys must not be written to disk; run this on a host with a RAM-backed /dev/shm`,
	)
}

/** The pid namespace (and boot) of this process, short enough for a directory name. */
function namespaceTag(): string | undefined {
	const ns = pidNamespace()
	return ns === undefined ? undefined : createHash("sha256").update(ns).digest("hex").slice(0, 12)
}

/**
 * Removes the `label` stores in `root` whose owner, named in the store's name, is no longer running:
 * its pid is gone, or now belongs to a process with another start time. A store named under another
 * pid namespace (another container sharing the directory) is left alone, since its owner cannot be seen
 * from here. Only real directories this uid owns, so nothing another user planted in the world-writable
 * `/dev/shm` is followed or removed. A removal that fails, such as one racing another creator's, is
 * skipped: it never fails the caller's own store.
 */
function reapOrphans(root: string, label: string, tag: string): void {
	let names: string[]
	try {
		names = readdirSync(root)
	} catch {
		return
	}
	const shape = new RegExp(`^pp-${label}-${tag}-(\\d+)-(\\d+)-[A-Za-z0-9]{6}$`)
	for (const name of names) {
		const owner = shape.exec(name)
		if (!owner || startTime(Number(owner[1])) === owner[2]) continue
		const path = join(root, name)
		try {
			const st = lstatSync(path)
			if (st.isDirectory() && st.uid === process.getuid?.()) rmSync(path, { recursive: true, force: true })
		} catch {}
	}
}

/**
 * `mkdtemp` directly in the world-writable `/dev/shm`: a shared parent there could be pre-planted as a
 * symlink to disk by another local user. The name carries this process's pid namespace, pid and start
 * time, so a later store can tell a dead owner from a live one, from an unrelated process that took the
 * same pid, and from a process in another container.
 */
function freshDir(label: string, sandboxKeysOnly: boolean): string {
	const root = storeRoot({ sandboxKeysOnly })
	if (root !== "/dev/shm") mkdirSync(root, { recursive: true, mode: 0o700 })
	const tag = namespaceTag()
	const self = startTime(process.pid)
	if (tag === undefined || self === undefined) return mkdtempSync(join(root, `pp-${label}-`))
	for (const r of new Set([root, diskRoot(), "/dev/shm"])) reapOrphans(r, label, tag)
	return mkdtempSync(join(root, `pp-${label}-${tag}-${process.pid}-${self}-`))
}

/**
 * A fresh wallet store this process owns, removed when it exits. The store holds the account's secret
 * and signing keys, so it never sits in the SDK's default `./aztec-wallet-data`, which is in the tree
 * and shared between runs. Removal covers an exit and a signal. A SIGKILL or a crash skips it, so each
 * new store first removes the stores of owners that are gone; without `/proc` (macOS) it cannot tell
 * and removes none. The signal fallback is prepended so it counts a `once` handler before that handler
 * is dropped: it exits only when nothing else handles the signal, and a handler that does (the
 * sandbox's async reaper) exits through `process.exit`, which runs the removal.
 * @param label lower-case letters and digits, starting with a letter.
 * @throws for real keys (`sandboxKeysOnly` unset) on a host without a tmpfs `/dev/shm`.
 */
export function ownedWalletStore(label: string, opts: { sandboxKeysOnly?: boolean } = {}): string {
	if (!LABEL.test(label)) throw new Error(`wallet store label ${JSON.stringify(label)} must match ${LABEL}`)
	const dir = freshDir(label, opts.sandboxKeysOnly ?? false)
	if (owned.length === 0) {
		process.once("exit", () => {
			for (const dir of owned) rmSync(dir, { recursive: true, force: true })
		})
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
			process.prependListener(signal, () => {
				if (process.listenerCount(signal) === 1) process.exit(128 + osConstants.signals[signal])
			})
		}
	}
	owned.push(dir)
	return dir
}
