import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { crc32 } from "node:zlib"
import { afterEach, describe, expect, it } from "vitest"
import { downloadPinned, fetchWallet, readWalletPin, type WalletPin } from "./fetch-wallet"
import { extractZip } from "./zip"

/** A stored (uncompressed) zip; `mode` sets a Unix file type in the external attributes. */
function zipOf(files: { name: string; data?: string; mode?: number }[]): Buffer {
	const locals: Buffer[] = []
	const centrals: Buffer[] = []
	let offset = 0
	for (const f of files) {
		const name = Buffer.from(f.name, "latin1")
		const data = Buffer.from(f.data ?? "")
		const crc = crc32(data) >>> 0
		const loc = Buffer.alloc(30)
		loc.writeUInt32LE(0x04034b50, 0)
		loc.writeUInt16LE(20, 4)
		loc.writeUInt32LE(crc, 14)
		loc.writeUInt32LE(data.length, 18)
		loc.writeUInt32LE(data.length, 22)
		loc.writeUInt16LE(name.length, 26)
		const cen = Buffer.alloc(46)
		cen.writeUInt32LE(0x02014b50, 0)
		cen.writeUInt16LE((3 << 8) | 20, 4)
		cen.writeUInt16LE(20, 6)
		cen.writeUInt32LE(crc, 16)
		cen.writeUInt32LE(data.length, 20)
		cen.writeUInt32LE(data.length, 24)
		cen.writeUInt16LE(name.length, 28)
		cen.writeUInt32LE(((f.mode ?? 0o100644) << 16) >>> 0, 38)
		cen.writeUInt32LE(offset, 42)
		locals.push(loc, name, data)
		centrals.push(cen, name)
		offset += 30 + name.length + data.length
	}
	const cd = Buffer.concat(centrals)
	const end = Buffer.alloc(22)
	end.writeUInt32LE(0x06054b50, 0)
	end.writeUInt16LE(files.length, 8)
	end.writeUInt16LE(files.length, 10)
	end.writeUInt32LE(cd.length, 12)
	end.writeUInt32LE(offset, 16)
	return Buffer.concat([...locals, cd, end])
}

const caps = { maxEntries: 16, maxBytes: 1024 }
const dirs: string[] = []
const scratch = () => {
	mkdirSync(join(homedir(), ".cache/pp"), { recursive: true })
	const d = mkdtempSync(join(homedir(), ".cache/pp/real-wallet-test-"))
	dirs.push(d)
	return d
}
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe("extractZip", () => {
	it("unpacks plain files and directories", () => {
		const dest = join(scratch(), "x")
		extractZip(
			zipOf([
				{ name: "manifest.json", data: "{}" },
				{ name: "assets/", mode: 0o040755 },
				{ name: "assets/a.js", data: "1" },
			]),
			dest,
			caps,
		)
		expect(readFileSync(join(dest, "assets/a.js"), "utf8")).toBe("1")
	})

	it.each([
		["a parent segment", [{ name: "../escape.txt", data: "x" }]],
		["an absolute name", [{ name: "/etc/escape", data: "x" }]],
		["a backslash", [{ name: "a\\..\\b", data: "x" }]],
		["a symlink", [{ name: "link", data: "/etc/passwd", mode: 0o120777 }]],
		["more bytes than the cap", [{ name: "big", data: "x".repeat(2048) }]],
	])("refuses %s before writing anything", (_why, files) => {
		const dest = join(scratch(), "x")
		expect(() => extractZip(zipOf(files), dest, caps)).toThrow(/zip:/)
		expect(existsSync(dest)).toBe(false)
	})
})

describe("fetchWallet", () => {
	const body = zipOf([{ name: "manifest.json", data: '{"manifest_version":3}' }])
	const pin: WalletPin = {
		...readWalletPin(),
		url: "http://wallet.invalid/w.zip",
		size: body.length,
		sha256: createHash("sha256").update(body).digest("hex"),
	}
	const serve = (bytes: Buffer, headers: Record<string, string> = {}) =>
		(async () => new Response(new Uint8Array(bytes), { headers })) as unknown as typeof fetch

	it("downloads once, caches the zip under its hash and unpacks it", async () => {
		const cacheDir = scratch()
		await fetchWallet(pin, { cacheDir, extensionDir: join(scratch(), "ext"), fetchImpl: serve(body) })
		expect(existsSync(join(cacheDir, `${pin.sha256}.zip`))).toBe(true)
		const refuse = (async () => {
			throw new Error("no second download")
		}) as unknown as typeof fetch
		await fetchWallet(pin, { cacheDir, extensionDir: join(scratch(), "ext"), fetchImpl: refuse })
	})

	it("refuses a tampered body and caches nothing", async () => {
		const cacheDir = join(scratch(), "cache")
		const tampered = Buffer.from(body)
		tampered[tampered.length - 30] ^= 1
		await expect(fetchWallet(pin, { cacheDir, extensionDir: join(scratch(), "ext"), fetchImpl: serve(tampered) })).rejects.toThrow(
			/does not match its pin/,
		)
		expect(existsSync(cacheDir)).toBe(false)
	})

	it("stops a body that runs past the pinned size", async () => {
		const longer = Buffer.concat([body, Buffer.alloc(64)])
		await expect(downloadPinned(pin.url, pin.size, pin.sha256, serve(longer))).rejects.toThrow(/more than the pinned/)
		await expect(downloadPinned(pin.url, pin.size, pin.sha256, serve(body, { "content-length": "999999999" }))).rejects.toThrow(
			/declares/,
		)
	})

	it("re-downloads over a cached zip that no longer matches", async () => {
		const cacheDir = scratch()
		await fetchWallet(pin, { cacheDir, extensionDir: join(scratch(), "ext"), fetchImpl: serve(body) })
		const cached = join(cacheDir, `${pin.sha256}.zip`)
		writeFileSync(cached, "edited")
		await fetchWallet(pin, { cacheDir, extensionDir: join(scratch(), "ext"), fetchImpl: serve(body) })
		expect(readFileSync(cached).equals(body)).toBe(true)
	})
})
