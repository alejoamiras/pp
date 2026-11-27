/**
 * The pinned wallet release, downloaded at most once per cache and unpacked per run. Only the zip
 * is cached, under its own sha256, and it is re-hashed on every use: an unpacked tree could be
 * edited in place between runs, a zip that still matches its pin cannot.
 */
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { downloadPinned, SHA256_HEX, sha256 } from "./download"
import { extractZip } from "./zip"

export interface WalletPin {
	version: string
	tag: string
	commit: string
	url: string
	sha256: string
	size: number
	publishedAt: string
	attestation: { signer: string; run: string }
}

export function readWalletPin(): WalletPin {
	return JSON.parse(readFileSync(new URL("./wallet-pin.json", import.meta.url), "utf8")) as WalletPin
}

/** The release unpacks to about 71 MB in 680 files; the caps leave room for growth, not for a bomb. */
const CAPS = { maxEntries: 4096, maxBytes: 192 * 2 ** 20 }

async function cachedZip(pin: WalletPin, cacheDir: string, fetchImpl: typeof fetch): Promise<Buffer> {
	const path = join(cacheDir, `${pin.sha256}.zip`)
	if (existsSync(path)) {
		const bytes = readFileSync(path)
		if (bytes.length === pin.size && sha256(bytes) === pin.sha256) return bytes
		rmSync(path, { force: true })
	}
	const bytes = await downloadPinned(pin.url, { size: pin.size, sha256: pin.sha256, fetchImpl })
	mkdirSync(cacheDir, { recursive: true })
	const part = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.part`
	writeFileSync(part, bytes, { flag: "wx" })
	renameSync(part, path)
	return bytes
}

/**
 * Unpacks the pinned release into `extensionDir`, which must not exist.
 * @throws Error when the pin's hash or size is malformed (before any download), when the download or
 *   the cache does not match the pin, or when the archive is refused
 */
export async function fetchWallet(pin: WalletPin, o: { cacheDir: string; extensionDir: string; fetchImpl?: typeof fetch }): Promise<void> {
	// An absent hash would skip the check, and the hash also names the cache file.
	if (!SHA256_HEX.test(String(pin.sha256)) || !Number.isSafeInteger(pin.size) || pin.size <= 0)
		throw new Error("wallet: the pin's sha256 or size is malformed")
	const zip = await cachedZip(pin, o.cacheDir, o.fetchImpl ?? fetch)
	extractZip(zip, o.extensionDir, CAPS)
	if (!existsSync(join(o.extensionDir, "manifest.json"))) throw new Error("wallet: the release has no manifest.json at its root")
}
