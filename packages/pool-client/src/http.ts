import { HTTPRequestFailed, HTTPResponseError, type HTTPRequestOptions, type IHTTPClient } from "./sdk.ts"

// The SDK client's defaults, so its providers time out and retry as they would with it.
const TIMEOUT_MS = 15_000
const RETRIES = 3
const RETRY_DELAY_MS = 500

type ParseAs = "json" | "binary"

/**
 * The error classes a provider recognises. A provider tells a 404 by `instanceof` against its own SDK
 * build's `HTTPResponseError`, so a caller on another build of the SDK passes that build's classes.
 */
export type HttpErrorClasses = {
	HTTPRequestFailed: new (message: string) => Error
	HTTPResponseError: new (status: number, statusText: string, body?: string) => Error
}

type Errors = HttpErrorClasses & { RedirectRefused: new (message: string) => Error }

/**
 * The SDK's HTTP client contract with redirects refused: the origin a caller pinned answers, and can
 * never send the request on to another URL, a loopback one included. A redirect is an
 * `HTTPRequestFailed` thrown at once, never retried; any other failure is the SDK client's, with its
 * timeout, retries and error classes, so a provider's fallback on a 404 behaves as with the SDK client.
 */
export function pinnedOriginHttpClient(classes: HttpErrorClasses = { HTTPRequestFailed, HTTPResponseError }): IHTTPClient {
	const errors: Errors = { ...classes, RedirectRefused: class extends classes.HTTPRequestFailed {} }
	return {
		get: (url, options) => request(errors, url, { method: "GET" }, options, "json"),
		post: (url, body, options) => request(errors, url, { method: "POST", body: JSON.stringify(body) }, options, "json"),
		getBinary: (url, options) => request(errors, url, { method: "GET" }, options, "binary"),
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
			if (e instanceof errors.HTTPResponseError || e instanceof errors.RedirectRefused) throw e
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
		// A browser hides a manual redirect's status behind an opaque response.
		if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
			await res.body?.cancel()
			throw new errors.RedirectRefused(`${new URL(url).origin} answered a redirect (${res.status}), which this client refuses`)
		}
		if (!res.ok) throw new errors.HTTPResponseError(res.status, res.statusText, await res.text().catch(() => undefined))
		return (as === "binary" ? new Uint8Array(await res.arrayBuffer()) : await res.json()) as T
	} finally {
		clearTimeout(timer)
		options?.signal?.removeEventListener("abort", forward)
	}
}
