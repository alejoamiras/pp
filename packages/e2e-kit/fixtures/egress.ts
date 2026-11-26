/**
 * Nothing leaves the machine. Every request that is not loopback is aborted and recorded; a test
 * asserts the record is empty at the end, so a new remote dependency fails loudly here.
 */
import type { BrowserContext } from "@playwright/test"

export interface Egress {
	/** URLs of every non-loopback request the context attempted, in order. */
	readonly blocked: string[]
}

const isLoopback = (host: string) => host === "127.0.0.1" || host === "localhost" || host === "[::1]"

export async function confineEgress(context: BrowserContext): Promise<Egress> {
	const blocked: string[] = []
	await context.route("**/*", (route) => {
		const url = new URL(route.request().url())
		if (isLoopback(url.hostname)) return route.continue()
		blocked.push(url.href)
		return route.abort("blockedbyclient")
	})
	return { blocked }
}
