/**
 * A download held to an exact length and, outside bump-time pinning, an exact sha256 before any
 * caller sees a byte: the stream stops at the cap, so a hostile or wrong response can neither fill
 * the disk nor reach a parser.
 */
import { createHash } from "node:crypto"

export const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")

export const SHA256_HEX = /^[0-9a-f]{64}$/

const DOWNLOAD_TIMEOUT_MS = 10 * 60_000

export interface Expected {
	size: number
	/** Omitted only when measuring a pin. */
	sha256?: string
	headers?: Record<string, string>
	fetchImpl?: typeof fetch
}

/** @throws Error on a non-2xx answer, more or fewer than `size` bytes, or a hash mismatch */
export async function downloadPinned(url: string, e: Expected): Promise<Buffer> {
	const res = await (e.fetchImpl ?? fetch)(url, {
		redirect: "follow",
		headers: e.headers,
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	})
	if (!res.ok || !res.body) throw new Error(`download: ${url} answered ${res.status}`)
	const declared = Number(res.headers.get("content-length") ?? Number.NaN)
	if (declared > e.size) {
		await res.body.cancel()
		throw new Error(`download: ${url} declares ${declared} bytes, above the pinned ${e.size}`)
	}
	const chunks: Uint8Array[] = []
	let got = 0
	for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
		got += chunk.length
		if (got > e.size) throw new Error(`download: ${url} sent more than the pinned ${e.size} bytes`)
		chunks.push(chunk)
	}
	const body = Buffer.concat(chunks)
	if (got !== e.size || (e.sha256 !== undefined && sha256(body) !== e.sha256))
		throw new Error(`download: ${url} does not match its pin (${got} bytes, sha256 ${sha256(body)})`)
	return body
}
