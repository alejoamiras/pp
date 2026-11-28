import { HTTPRequestFailed, HTTPResponseError, type HTTPRequestOptions, type IHTTPClient } from "./sdk.ts"

// The SDK client's defaults, so its providers time out and retry as they would with it.
const TIMEOUT_MS = 15_000
const RETRIES = 3
const RETRY_DELAY_MS = 500
/** The most decoded bytes one answer may carry; the SDK client reads any size. */
const MAX_BODY_BYTES = 16 * 1024 * 1024

type ParseAs = "json" | "binary"

/**
 * The error classes a provider recognises. A provider tells a 404 by `instanceof` against its own SDK
 * build's `HTTPResponseError`, so a caller on another build of the SDK passes that build's classes.
 */
export type HttpErrorClasses = {
	HTTPRequestFailed: new (message: string) => Error
	HTTPResponseError: new (status: number, statusText: string, body?: string) => Error
}

type Errors = HttpErrorClasses & { Refused: new (message: string) => Error }

/**
 * The SDK's HTTP client contract with redirects and oversized answers refused: the origin a caller
 * pinned answers, can never send the request on to another URL, a loopback one included, and can
 * never make the caller hold more than 16 MiB of one answer, decoded. A refusal is an
 * `HTTPRequestFailed` thrown at once, never retried; any other failure is the SDK client's, with its
 * timeout, retries and error classes, so a provider's fallback on a 404 behaves as with the SDK client.
 */
export function pinnedOriginHttpClient(classes: HttpErrorClasses = { HTTPRequestFailed, HTTPResponseError }): IHTTPClient {
	const errors: Errors = { ...classes, Refused: class extends classes.HTTPRequestFailed {} }
	return {
		get: async (url, options) => request(errors, url, { method: "GET" }, options, "json"),
		post: async (url, body, options) => request(errors, url, { method: "POST", body: JSON.stringify(body) }, options, "json"),
		getBinary: async (url, options) => request(errors, url, { method: "GET" }, options, "binary"),
	}
}

async function request<T>(
	errors: Errors,
	url: string,
	init: RequestInit,
	options: HTTPRequestOptions | undefined,
	as: ParseAs,
): Promise<T> {
	let last: unknown
	for (let attempt = 0; attempt <= RETRIES; attempt++) {
		try {
			return await once<T>(errors, url, init, options, as)
		} catch (e) {
			if (e instanceof errors.HTTPResponseError || e instanceof errors.Refused) throw e
			last = e
			if (attempt < RETRIES) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
		}
	}
	throw new errors.HTTPRequestFailed(last instanceof Error ? last.message : String(last))
}

/** One request; the timeout stays armed through the body read, since a body can stall after its headers. */
async function once<T>(errors: Errors, url: string, init: RequestInit, options: HTTPRequestOptions | undefined, as: ParseAs): Promise<T> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), options?.timeout ?? TIMEOUT_MS)
	const forward = () => controller.abort()
	if (options?.signal?.aborted) controller.abort()
	options?.signal?.addEventListener("abort", forward, { once: true })
	try {
		const res = await fetch(url, {
			...init,
			headers: { "Content-Type": "application/json", ...options?.headers },
			signal: controller.signal,
			cache: options?.cache,
			redirect: "manual",
		})
		const origin = new URL(url).origin
		// A browser hides a manual redirect's status behind an opaque response.
		if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
			// A cancel that rejects, as on a body that already errored, must not turn the refusal into a retry.
			await res.body?.cancel().catch(() => {})
			throw new errors.Refused(`${origin} answered a redirect (${res.status}), which this client refuses`)
		}
		if (!res.ok) throw new errors.HTTPResponseError(res.status, res.statusText, await errorBody(errors, res, origin))
		const bytes = await readCapped(errors, res, origin)
		return (as === "binary" ? bytes : JSON.parse(new TextDecoder().decode(bytes))) as T
	} finally {
		clearTimeout(timer)
		options?.signal?.removeEventListener("abort", forward)
	}
}

/** As the SDK client, a failed read leaves the error without a body; an oversized one is still refused. */
async function errorBody(errors: Errors, res: Response, origin: string): Promise<string | undefined> {
	try {
		return new TextDecoder().decode(await readCapped(errors, res, origin))
	} catch (e) {
		if (e instanceof errors.Refused) throw e
		return undefined
	}
}

/** The body as fetch decoded it, refused at the first chunk past the cap so a compressed bomb never inflates in full. */
async function readCapped(errors: Errors, res: Response, origin: string): Promise<Uint8Array> {
	if (res.body === null) return new Uint8Array()
	const reader = res.body.getReader()
	const chunks: Uint8Array[] = []
	let size = 0
	for (let next = await reader.read(); !next.done; next = await reader.read()) {
		size += next.value.byteLength
		if (size > MAX_BODY_BYTES) {
			await reader.cancel().catch(() => {})
			throw new errors.Refused(`${origin} answered more than ${MAX_BODY_BYTES} bytes, which this client refuses`)
		}
		chunks.push(next.value)
	}
	const body = new Uint8Array(size)
	let at = 0
	for (const chunk of chunks) {
		body.set(chunk, at)
		at += chunk.byteLength
	}
	return body
}
