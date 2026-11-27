import { type Hex, MAX_LEAVES } from "@pp/label-paths"
import pkg from "../package.json" with { type: "json" }

const DECIMAL = /^(0|[1-9][0-9]{0,77})$/
const HEX_WORD = /^0x[0-9a-fA-F]{1,64}$/

/** Every User-Agent this bot sends starts with it, so the operator can find the bot in their logs. */
export const BOT_PRODUCT = "pp-aztec-bridge-bot"
export const DEFAULT_USER_AGENT = `${BOT_PRODUCT}/${pkg.version}`

/** The widest leaf in JSON (78 digits, quotes, a comma) with room for formatting, times the registry's list limit. */
export const MAX_BODY_BYTES = MAX_LEAVES * 96

/** One pool of a multi-pool ASP API: `chainId` alone is ambiguous on a chain with two pools. */
export type AspScope = { chainId: number; entrypoint: Hex }

export type AspRequest = { userAgent?: string; timeoutMs?: number }

const LEAVES = "association-set/leaves"
const ROOT = "association-set/root"

function endpoint(aspApiUrl: string, path: string, scope?: AspScope): URL {
	const url = new URL(path, aspApiUrl.endsWith("/") ? aspApiUrl : `${aspApiUrl}/`)
	if (scope) {
		url.searchParams.set("chainId", String(scope.chainId))
		url.searchParams.set("entrypoint", scope.entrypoint)
	}
	return url
}

const tooLarge = (path: string) => new Error(`${path}: the answer exceeds ${MAX_BODY_BYTES} bytes`)

/**
 * One GET carrying the bot's User-Agent. A redirect fails, so one call is one request to this host with its
 * query. The deadline covers the whole body, and the body is cut off at {@link MAX_BODY_BYTES}.
 */
async function getText(url: URL, path: string, o: AspRequest): Promise<string> {
	const res = await fetch(url, {
		headers: { "user-agent": o.userAgent ?? DEFAULT_USER_AGENT },
		redirect: "error",
		signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
	})
	if (!res.ok || Number(res.headers.get("content-length")) > MAX_BODY_BYTES) {
		await res.body?.cancel()
		throw res.ok ? tooLarge(path) : new Error(`${path}: HTTP ${res.status}`)
	}
	if (!res.body) return ""
	const reader = res.body.getReader()
	const decoder = new TextDecoder()
	let text = ""
	let bytes = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done) return text + decoder.decode()
		bytes += value.byteLength
		if (bytes > MAX_BODY_BYTES) {
			await reader.cancel()
			throw tooLarge(path)
		}
		text += decoder.decode(value, { stream: true })
	}
}

/** The parsed body; an error never quotes it. */
function parse(text: string, path: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		throw new Error(`${path}: the answer is not JSON`)
	}
}

/** Whether `text` holds more than `limit` commas, stopping at the first one past it. */
function commasExceed(text: string, limit: number): boolean {
	let n = 0
	for (let i = text.indexOf(","); i !== -1; i = text.indexOf(",", i + 1)) if (++n > limit) return true
	return false
}

async function leavesAt(url: URL, o: AspRequest): Promise<bigint[]> {
	const text = await getText(url, LEAVES, o)
	// A decimal leaf holds no comma, so this bounds the array before JSON.parse allocates it.
	if (commasExceed(text, MAX_LEAVES + 16)) throw new Error(`${LEAVES}: more than ${MAX_LEAVES} leaves`)
	const leaves = (parse(text, LEAVES) as { leaves?: unknown } | null)?.leaves
	if (Array.isArray(leaves) && leaves.length > MAX_LEAVES) throw new Error(`${LEAVES}: more than ${MAX_LEAVES} leaves`)
	if (!Array.isArray(leaves) || !leaves.every((l) => typeof l === "string" && DECIMAL.test(l))) {
		throw new Error(`${LEAVES}: not a list of decimal strings`)
	}
	return leaves.map((l) => BigInt(l))
}

/** The ASP API's current leaves (`GET /association-set/leaves`), in its order; the caller checks they hash to the chain's root. */
export async function fetchLeaves(aspApiUrl: string, o: AspRequest = {}): Promise<bigint[]> {
	return leavesAt(endpoint(aspApiUrl, LEAVES), o)
}

/** {@link fetchLeaves} for one pool, named by `?chainId=&entrypoint=`; the caller checks the leaves hash to that pool's root. */
export async function fetchScopedLeaves(aspApiUrl: string, scope: AspScope, o: AspRequest = {}): Promise<bigint[]> {
	return leavesAt(endpoint(aspApiUrl, LEAVES, scope), o)
}

/** The root the ASP API claims for one pool (`GET /association-set/root`): a decimal or `0x` field element. */
export async function fetchScopedRoot(aspApiUrl: string, scope: AspScope, o: AspRequest = {}): Promise<bigint> {
	const root = (parse(await getText(endpoint(aspApiUrl, ROOT, scope), ROOT, o), ROOT) as { root?: unknown } | null)?.root
	if (typeof root !== "string" || !(DECIMAL.test(root) || HEX_WORD.test(root))) throw new Error(`${ROOT}: not a decimal or 0x root`)
	return BigInt(root)
}
