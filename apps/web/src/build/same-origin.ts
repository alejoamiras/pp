/**
 * The paths a testnet target gives the pool's ASP API and the ASP bot. The app's own server proxies
 * both under the page's origin, which is known only in the page (the owner reaches it through a
 * forwarded port), so the build carries these paths and `src/target.ts` resolves them at load.
 */
import type { PublicTarget } from "./target.ts"

export const SAME_ORIGIN = { asp: "/asp", bot: "/bot" } as const

export const isSameOriginPath = (url: string): boolean => url === SAME_ORIGIN.asp || url === SAME_ORIGIN.bot

/**
 * `t` with its same-origin paths made absolute against `origin`; any other target unchanged.
 *
 * @throws when only one of the ASP and bot URLs is a same-origin path (no build writes that), or when
 *   `origin` is missing for a target that needs it.
 */
export function resolveSameOrigin(t: PublicTarget, origin: string | undefined): PublicTarget {
	const stack = t.stack
	if (stack === null) return t
	const { aspApiUrl } = stack.manifest.pool
	const proxied = [isSameOriginPath(aspApiUrl), isSameOriginPath(stack.botUrl)]
	if (!proxied.includes(true)) return t
	if (proxied.includes(false)) throw new Error("target: the ASP and the bot must both be same-origin paths, or neither")
	if (origin === undefined) throw new Error("target: same-origin paths need the page's origin")
	return {
		...t,
		stack: {
			...stack,
			botUrl: `${origin}${stack.botUrl}`,
			manifest: { ...stack.manifest, pool: { ...stack.manifest.pool, aspApiUrl: `${origin}${aspApiUrl}` } },
		},
	}
}
