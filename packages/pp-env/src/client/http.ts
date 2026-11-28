import { type HTTPRequestOptions, HTTPRequestFailed, HTTPResponseError, type IHTTPClient } from "#ppv2/core-sdk"

// The SDK client's defaults, so its providers time out and retry as they would with it.
const TIMEOUT_MS = 15_000
const RETRIES = 3
const RETRY_DELAY_MS = 500

type ParseAs = "json" | "binary"

/** A redirect, refused rather than followed and never retried. */
class RedirectRefused extends HTTPRequestFailed {}

/**
 * The SDK's HTTP client contract with redirects refused: the origin a caller pinned answers, and can
 * never send the request on to another URL, a loopback one included. Failures are the SDK's own error
 * classes, so a provider's fallback on an `HTTPResponseError` status behaves as with the SDK client.
 */
export class PinnedOriginHttpClient implements IHTTPClient {
	get<T>(url: string, options?: HTTPRequestOptions): Promise<T> {
		return this.request<T>(url, { method: "GET" }, options, "json")
	}

	post<T>(url: string, body: unknown, options?: HTTPRequestOptions): Promise<T> {
		return this.request<T>(url, { method: "POST", body: JSON.stringify(body) }, options, "json")
	}

	getBinary(url: string, options?: HTTPRequestOptions): Promise<Uint8Array> {
		return this.request<Uint8Array>(url, { method: "GET" }, options, "binary")
	}

	private async request<T>(url: string, init: RequestInit, options: HTTPRequestOptions | undefined, as: ParseAs): Promise<T> {
		let last: unknown
		for (let attempt = 0; attempt <= RETRIES; attempt++) {
			try {
				return await once<T>(url, init, options, as)
			} catch (e) {
				if (e instanceof HTTPResponseError || e instanceof RedirectRefused) throw e
				last = e
				if (attempt < RETRIES) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
			}
		}
		throw new HTTPRequestFailed(last instanceof Error ? last.message : String(last))
	}
}

/** One request; the timeout stays armed through the body read, since a body can stall after its headers. */
async function once<T>(url: string, init: RequestInit, options: HTTPRequestOptions | undefined, as: ParseAs): Promise<T> {
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
		if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
			await res.body?.cancel()
			throw new RedirectRefused(`${new URL(url).origin} answered a redirect (${res.status}), which this client refuses`)
		}
		if (!res.ok) throw new HTTPResponseError(res.status, res.statusText, await res.text().catch(() => undefined))
		return (as === "binary" ? new Uint8Array(await res.arrayBuffer()) : await res.json()) as T
	} finally {
		clearTimeout(timer)
		options?.signal?.removeEventListener("abort", forward)
	}
}
