/**
 * Extracts a zip of regular files into a directory that must not exist yet. Refuses, before
 * writing anything, an archive with zip64 or encrypted entries, a method other than stored or
 * deflate, a symlink or other special file, a name that is absolute, has a `.`/`..` segment or a
 * backslash, or a total above the caps; each entry's inflated length and CRC must match.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { crc32, inflateRawSync } from "node:zlib"

export interface ZipCaps {
	maxEntries: number
	/** Sum of the declared uncompressed sizes. */
	maxBytes: number
}

interface Entry {
	name: string
	method: number
	crc: number
	compressed: number
	size: number
	localOffset: number
	dir: boolean
}

const EOCD = 0x06054b50
const CEN = 0x02014b50
const LOC = 0x04034b50
const S_IFMT = 0o170000
const S_IFREG = 0o100000
const S_IFDIR = 0o040000

function findEocd(buf: Buffer): number {
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === EOCD) return i
	throw new Error("zip: no end-of-central-directory record")
}

function checkName(name: string, dir: boolean): void {
	const body = dir ? name.slice(0, -1) : name
	const bad =
		!/^[\x20-\x7e]+$/.test(name) ||
		name.startsWith("/") ||
		name.includes("\\") ||
		name.includes(":") ||
		body.split("/").some((seg) => seg === "" || seg === "." || seg === "..")
	if (bad) throw new Error(`zip: refused entry name ${JSON.stringify(name)}`)
}

function checkMode(e: Entry, madeBy: number, external: number): void {
	// Only a Unix-made entry carries a file type; anything but a plain file or directory is refused.
	if (madeBy >> 8 !== 3) return
	const type = (external >>> 16) & S_IFMT
	if (type !== 0 && type !== (e.dir ? S_IFDIR : S_IFREG))
		throw new Error(`zip: ${e.name} is not a regular file (mode ${type.toString(8)})`)
}

/** One central-directory record at `p`, checked, and the offset of the next. */
function readEntry(buf: Buffer, p: number): { e: Entry; next: number } {
	if (buf.readUInt32LE(p) !== CEN) throw new Error("zip: malformed central directory")
	const nameLen = buf.readUInt16LE(p + 28)
	const name = buf.toString("latin1", p + 46, p + 46 + nameLen)
	const e: Entry = {
		name,
		method: buf.readUInt16LE(p + 10),
		crc: buf.readUInt32LE(p + 16),
		compressed: buf.readUInt32LE(p + 20),
		size: buf.readUInt32LE(p + 24),
		localOffset: buf.readUInt32LE(p + 42),
		dir: name.endsWith("/"),
	}
	if (buf.readUInt16LE(p + 8) & 1) throw new Error(`zip: ${name} is encrypted`)
	if (e.method !== 0 && e.method !== 8) throw new Error(`zip: ${name} uses method ${e.method}`)
	if (e.size === 0xffffffff || e.compressed === 0xffffffff || e.localOffset === 0xffffffff) throw new Error("zip: zip64 is refused")
	checkName(name, e.dir)
	checkMode(e, buf.readUInt16LE(p + 4), buf.readUInt32LE(p + 38))
	return { e, next: p + 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32) }
}

function readEntries(buf: Buffer, caps: ZipCaps): Entry[] {
	const eocd = findEocd(buf)
	const count = buf.readUInt16LE(eocd + 10)
	const cdSize = buf.readUInt32LE(eocd + 12)
	const cdOffset = buf.readUInt32LE(eocd + 16)
	if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("zip: zip64 is refused")
	if (count > caps.maxEntries) throw new Error(`zip: ${count} entries exceed the cap of ${caps.maxEntries}`)
	if (cdOffset + cdSize > eocd) throw new Error("zip: central directory overlaps its end record")
	const entries: Entry[] = []
	let total = 0
	let p = cdOffset
	for (let i = 0; i < count; i++) {
		const { e, next } = readEntry(buf, p)
		total += e.size
		if (total > caps.maxBytes) throw new Error(`zip: entries exceed the cap of ${caps.maxBytes} bytes`)
		entries.push(e)
		p = next
	}
	return entries
}

function inflate(buf: Buffer, e: Entry): Buffer {
	const p = e.localOffset
	if (buf.readUInt32LE(p) !== LOC) throw new Error(`zip: ${e.name} has no local header`)
	const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28)
	const raw = buf.subarray(start, start + e.compressed)
	const out = e.method === 0 ? raw : inflateRawSync(raw, { maxOutputLength: Math.max(e.size, 1) })
	if (out.length !== e.size || crc32(out) >>> 0 !== e.crc) throw new Error(`zip: ${e.name} does not match its declared size or CRC`)
	return out
}

/** @throws Error naming the first refused entry; `destDir` is then left absent or partial, never outside itself. */
export function extractZip(zip: Buffer, destDir: string, caps: ZipCaps): void {
	const entries = readEntries(zip, caps)
	mkdirSync(destDir)
	for (const e of entries) {
		const path = join(destDir, e.name)
		if (e.dir) {
			mkdirSync(path, { recursive: true })
			continue
		}
		mkdirSync(dirname(path), { recursive: true })
		writeFileSync(path, inflate(zip, e), { flag: "wx" })
	}
}
