/**
 * The pinned wallet release, downloaded at most once per cache and unpacked per run. Only the zip
 * is cached, under its own sha256, and it is re-hashed on every use: an unpacked tree could be
 * edited in place between runs, a zip that still matches its pin cannot.
 */
import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
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

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")
/** The release unpacks to about 71 MB in 680 files; the caps leave room for growth, not for a bomb. */
const CAPS = { maxEntries: 4096, maxBytes: 192 * 2 ** 20 }
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000

/** Streams `url`, refusing more than `size` bytes, and returns the body only if its length and hash match. */
export async function downloadPinned(url: string, size: number, digest: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
	const res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
	if (!res.ok || !res.body) throw new Error(`wallet: ${url} answered ${res.status}`)
	const declared = Number(res.headers.get("content-length") ?? Number.NaN)
	if (declared > size) {
		await res.body.cancel()
		throw new Error(`wallet: ${url} declares ${declared} bytes, above the pinned ${size}`)
	}
	const chunks: Uint8Array[] = []
	let got = 0
	for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
		got += chunk.length
		if (got > size) throw new Error(`wallet: ${url} sent more than the pinned ${size} bytes`)
		chunks.push(chunk)
	}
	const body = Buffer.concat(chunks)
	if (got !== size || sha256(body) !== digest)
		throw new Error(`wallet: ${url} does not match its pin (${got} bytes, sha256 ${sha256(body)})`)
	return body
}

async function cachedZip(pin: WalletPin, cacheDir: string, fetchImpl: typeof fetch): Promise<Buffer> {
	const path = join(cacheDir, `${pin.sha256}.zip`)
	if (existsSync(path)) {
		const bytes = readFileSync(path)
		if (bytes.length === pin.size && sha256(bytes) === pin.sha256) return bytes
		rmSync(path, { force: true })
	}
	const bytes = await downloadPinned(pin.url, pin.size, pin.sha256, fetchImpl)
	mkdirSync(cacheDir, { recursive: true })
	const part = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.part`
	writeFileSync(part, bytes, { flag: "wx" })
	renameSync(part, path)
	return bytes
}

/**
 * Unpacks the pinned release into `extensionDir`, which must not exist.
 * @throws Error when the download or the cache does not match the pin, or the archive is refused
 */
export async function fetchWallet(pin: WalletPin, o: { cacheDir: string; extensionDir: string; fetchImpl?: typeof fetch }): Promise<void> {
	const zip = await cachedZip(pin, o.cacheDir, o.fetchImpl ?? fetch)
	extractZip(zip, o.extensionDir, CAPS)
	if (!existsSync(join(o.extensionDir, "manifest.json"))) throw new Error("wallet: the release has no manifest.json at its root")
}
