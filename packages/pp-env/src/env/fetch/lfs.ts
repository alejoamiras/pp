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
	const body = (await res.json()) as BatchResponse
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

/** Streams one object, refusing more than `size` bytes, and checks length and sha256 against the pointer. */
export async function downloadVerified(dl: LfsDownload, pointer: LfsPointer, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
	const res = await fetchImpl(dl.href, { headers: dl.header })
	if (!res.ok || !res.body) throw new Error(`LFS download failed: HTTP ${res.status}`)
	const buf = new Uint8Array(pointer.size)
	const hash = createHash("sha256")
	let n = 0
	for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
		if (n + chunk.length > pointer.size) throw new Error(`LFS object ${pointer.oid} exceeds its pointer size ${pointer.size}`)
		buf.set(chunk, n)
		hash.update(chunk)
		n += chunk.length
	}
	if (n !== pointer.size) throw new Error(`LFS object ${pointer.oid} is ${n} bytes, pointer says ${pointer.size}`)
	const got = hash.digest("hex")
	if (got !== pointer.oid) throw new Error(`LFS object sha256 ${got} does not match pointer ${pointer.oid}`)
	return buf
}
