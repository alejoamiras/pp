/**
 * Nothing leaves the machine. Every request and WebSocket that is not loopback is refused and
 * recorded; a test asserts the record is empty at the end, so a new remote dependency fails loudly.
 */
import type { BrowserContext } from "@playwright/test"

export interface Egress {
	/** URLs of every non-loopback request or WebSocket the context attempted, in order. */
	readonly blocked: string[]
}

const isLoopback = (host: string) => host === "127.0.0.1" || host === "localhost" || host === "[::1]"

export async function confineEgress(context: BrowserContext): Promise<Egress> {
	const blocked: string[] = []
	// Every HTTP hop raises `request`, redirects included; only the first hop reaches `route`. So
	// `request` records and `route` blocks. A redirect from a loopback server is recorded, not stopped.
	context.on("request", (request) => {
		const url = new URL(request.url())
		if (/^https?:$/.test(url.protocol) && !isLoopback(url.hostname)) blocked.push(url.href)
	})
	await context.route("**/*", (route) =>
		isLoopback(new URL(route.request().url()).hostname) ? route.continue() : route.abort("blockedbyclient"),
	)
	// WebSockets never reach `route`; they have their own router.
	await context.routeWebSocket(/.*/, (ws) => {
		const url = new URL(ws.url())
		if (isLoopback(url.hostname)) return ws.connectToServer()
		blocked.push(url.href)
		return ws.close({ code: 1008, reason: "egress blocked" })
	})
	return { blocked }
}
