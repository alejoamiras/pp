import { createHash } from "node:crypto"

export type LfsPointer = { oid: string; size: number }
export type LfsDownload = { href: string; header?: Record<string, string> }

const POINTER_VERSION = "version https://git-lfs.github.com/spec/v1"

export function parsePointer(text: string): LfsPointer {
	const lines = text.trim().split("\n")
	if (lines[0] !== POINTER_VERSION) throw new Error("not a git-lfs pointer")
	const oid = /^oid sha256:([0-9a-f]{64})$/m.exec(text)?.[1]
	const size = Number(/^size (\d+)$/m.exec(text)?.[1])
	if (!oid || !Number.isSafeInteger(size) || size <= 0) throw new Error("malformed git-lfs pointer")
	return { oid, size }
}

type BatchResponse = { objects?: { oid: string; size: number; error?: { message: string }; actions?: { download?: LfsDownload } }[] }

/** A batch for every pinned object fits in a few kilobytes. */
const BATCH_RESPONSE_MAX = 1 << 20

/** Reads a response body, cancelling the stream as soon as it passes `max` bytes. */
export async function readCapped(res: Response, max: number, what: string): Promise<Uint8Array> {
	if (!res.body) throw new Error(`${what}: empty response`)
	const reader = res.body.getReader()
	const chunks: Uint8Array[] = []
	let n = 0
	for (let r = await reader.read(); !r.done; r = await reader.read()) {
		n += r.value.length
		if (n > max) {
			await reader.cancel()
			throw new Error(`${what} exceeds ${max} bytes`)
		}
		chunks.push(r.value)
	}
	return Buffer.concat(chunks)
}

/** One batch request; the response must name exactly the requested oids, each with a download action. */
export async function requestBatch(
	repo: string,
	pointers: LfsPointer[],
	fetchImpl: typeof fetch = fetch,
): Promise<Map<string, LfsDownload>> {
	// The batch API answers 422 to unknown object fields or duplicate oids.
	const objects = [...new Map(pointers.map(({ oid, size }) => [oid, { oid, size }])).values()]
	const res = await fetchImpl(`https://github.com/${repo}.git/info/lfs/objects/batch`, {
		method: "POST",
		headers: { accept: "application/vnd.git-lfs+json", "content-type": "application/vnd.git-lfs+json" },
		body: JSON.stringify({ operation: "download", transfers: ["basic"], objects }),
	})
	if (!res.ok) throw new Error(`LFS batch request failed: HTTP ${res.status}`)
	const body = JSON.parse(new TextDecoder().decode(await readCapped(res, BATCH_RESPONSE_MAX, "LFS batch response"))) as BatchResponse
	const wanted = new Set(pointers.map((p) => p.oid))
	const got = new Map<string, LfsDownload>()
	for (const o of body.objects ?? []) {
		if (!wanted.has(o.oid)) throw new Error(`LFS batch returned an unrequested object ${o.oid}`)
		if (o.error || !o.actions?.download) throw new Error(`LFS object ${o.oid} has no download: ${o.error?.message ?? "missing action"}`)
		got.set(o.oid, o.actions.download)
	}
	for (const oid of wanted) if (!got.has(oid)) throw new Error(`LFS batch omitted object ${oid}`)
	return got
}

/** Streams one pinned object, refusing more than its `size` bytes, and checks length and sha256 against the pin. */
export async function downloadVerified(dl: LfsDownload, pin: LfsPointer, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
	const res = await fetchImpl(dl.href, { headers: dl.header })
	if (!res.ok) throw new Error(`download of ${pin.oid} failed: HTTP ${res.status}`)
	const bytes = await readCapped(res, pin.size, `object ${pin.oid}`)
	if (bytes.length !== pin.size) throw new Error(`object ${pin.oid} is ${bytes.length} bytes, pinned at ${pin.size}`)
	const got = createHash("sha256").update(bytes).digest("hex")
	if (got !== pin.oid) throw new Error(`object sha256 ${got} does not match its pin ${pin.oid}`)
	return bytes
}
