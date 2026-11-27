const RPC_TIMEOUT_MS = 5_000

export async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
	})
	const body = (await res.json()) as { result?: T; error?: { message: string } }
	if (body.error || body.result === undefined) throw new Error(`${method}: ${body.error?.message ?? "no result"}`)
	return body.result
}

/** Polls `probe` until it holds; a probe still pending at the deadline counts as a failure. */
export async function waitFor(
	label: string,
	probe: () => Promise<boolean>,
	timeoutMs: number,
	exitReason?: () => string | undefined,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const expired = new Promise<"expired">((resolve) => {
		timer = setTimeout(() => resolve("expired"), timeoutMs)
	})
	try {
		for (;;) {
			const reason = exitReason?.()
			if (reason) throw new Error(`${label} ended before it became ready: ${reason}`)
			const outcome = await Promise.race([probe().catch(() => false), expired])
			if (outcome === true) return
			if (outcome === "expired" || (await Promise.race([pause(250), expired])) === "expired") break
		}
	} finally {
		clearTimeout(timer)
	}
	throw new Error(`${label} did not become ready within ${timeoutMs} ms`)
}

const pause = (ms: number) => new Promise<"paused">((r) => setTimeout(() => r("paused"), ms))
