import { createHash } from "node:crypto"
import { lstat, readdir, readFile, readlink } from "node:fs/promises"
import { join, relative } from "node:path"

export function sha256Hex(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex")
}

export async function sha256File(path: string): Promise<string> {
	return sha256Hex(await readFile(path))
}

/** Sorted repo-relative file paths under `dir`; symlinks are listed, not followed. */
export async function listFiles(dir: string, skip: (rel: string) => boolean = () => false): Promise<string[]> {
	const out: string[] = []
	async function walk(abs: string): Promise<void> {
		for (const entry of await readdir(abs, { withFileTypes: true })) {
			const child = join(abs, entry.name)
			const rel = relative(dir, child)
			if (skip(rel)) continue
			if (entry.isDirectory()) await walk(child)
			else out.push(rel)
		}
	}
	await walk(dir)
	return out.sort()
}

/**
 * Content digest of a directory: sha256 over "<path>\0<sha256>\n" lines in path order.
 * A symlink contributes its target string, so a swapped link changes the digest.
 */
export async function treeDigest(dir: string, skip?: (rel: string) => boolean): Promise<string> {
	const lines: string[] = []
	for (const rel of await listFiles(dir, skip)) {
		const abs = join(dir, rel)
		const st = await lstat(abs)
		const content = st.isSymbolicLink() ? `link:${await readlink(abs)}` : await sha256File(abs)
		lines.push(`${rel}\0${content}\n`)
	}
	return sha256Hex(lines.join(""))
}
