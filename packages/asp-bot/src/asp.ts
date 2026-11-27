import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib"
import { BN254_P } from "@pp/bridge-spec"
import { type Hex, MAX_LEAVES } from "@pp/label-paths"
import pkg from "../package.json" with { type: "json" }

const DECIMAL = /^(0|[1-9][0-9]{0,77})$/
const HEX_WORD = /^0x[0-9a-fA-F]{1,64}$/

/** Every User-Agent this bot sends starts with it, so the operator can find the bot in their logs. */
export const BOT_PRODUCT = "pp-aztec-bridge-bot"
export const DEFAULT_USER_AGENT = `${BOT_PRODUCT}/${pkg.version}`
const USER_AGENT = new RegExp(`^${BOT_PRODUCT}(?:/[\\x21-\\x7e]*)?(?: [\\x21-\\x7e]+)*$`)

/** The bot's product token, optionally `/version` and space-separated comments: printable ASCII, at most 128 characters. */
export const isBotUserAgent = (ua: unknown): ua is string => typeof ua === "string" && ua.length <= 128 && USER_AGENT.test(ua)

/** The widest leaf in JSON (78 digits, quotes, a comma) with room for formatting, times the registry's list limit. */
export const MAX_BODY_BYTES = MAX_LEAVES * 96

/** One pool of a multi-pool ASP API: `chainId` alone is ambiguous on a chain with two pools. */
export type AspScope = { chainId: number; entrypoint: Hex }

export type AspRequest = { userAgent?: string; timeoutMs?: number }

const LEAVES = "association-set/leaves"
const ROOT = "association-set/root"

/** Raised with a fixed message: nothing the API or the URL holds reaches a log through it. */
class AspError extends Error {}

const tooLarge = (path: string) => new AspError(`${path}: the answer exceeds ${MAX_BODY_BYTES} bytes`)

type Inflate = (b: Buffer, o: { maxOutputLength: number }) => Buffer

const TOO_LARGE = "ERR_BUFFER_TOO_LARGE"
const codeOf = (e: unknown) => (e as { code?: unknown } | null)?.code

/** `deflate` is zlib-wrapped by the standard, but servers also send it raw. */
const inflateEither: Inflate = (b, o) => {
	try {
		return inflateSync(b, o)
	} catch (e) {
		if (codeOf(e) === TOO_LARGE) throw e
		return inflateRawSync(b, o)
	}
}

const INFLATE = new Map<string, Inflate>([
	["gzip", gunzipSync],
	["x-gzip", gunzipSync],
	["deflate", inflateEither],
	["br", brotliDecompressSync],
])

const decode = (b: Uint8Array) => new TextDecoder().decode(b)

async function readCapped(body: ReadableStream<Uint8Array>, path: string): Promise<Buffer> {
	const chunks: Uint8Array[] = []
	let bytes = 0
	const reader = body.getReader()
	for (;;) {
		const { done, value } = await reader.read()
		if (done) return Buffer.concat(chunks)
		bytes += value.byteLength
		if (bytes > MAX_BODY_BYTES) {
			await reader.cancel()
			throw tooLarge(path)
		}
		chunks.push(value)
	}
}

function reading(res: Response, path: string): { inflate: Inflate | null } | AspError {
	if (!res.ok) return new AspError(`${path}: HTTP ${res.status}`)
	const encoding = (res.headers.get("content-encoding") ?? "identity").trim().toLowerCase()
	const inflate = encoding === "identity" ? null : INFLATE.get(encoding)
	if (inflate === undefined) return new AspError(`${path}: unsupported content-encoding`)
	if (Number(res.headers.get("content-length")) > MAX_BODY_BYTES) return tooLarge(path)
	return { inflate }
}

function endpoint(aspApiUrl: string, path: string, scope: AspScope | undefined): URL {
	const url = new URL(path, aspApiUrl.endsWith("/") ? aspApiUrl : `${aspApiUrl}/`)
	if (scope) {
		url.searchParams.set("chainId", String(scope.chainId))
		url.searchParams.set("entrypoint", scope.entrypoint)
	}
	return url
}

async function request(aspApiUrl: string, path: string, scope: AspScope | undefined, o: AspRequest): Promise<string> {
	const userAgent = o.userAgent ?? DEFAULT_USER_AGENT
	if (!isBotUserAgent(userAgent)) throw new AspError(`${path}: the User-Agent must start with ${BOT_PRODUCT}`)
	const res = await fetch(endpoint(aspApiUrl, path, scope), {
		headers: { "user-agent": userAgent, "accept-encoding": "identity" },
		redirect: "error",
		// Bun resends a request whose reused connection drops, which would make one attempt two requests.
		keepalive: false,
		// Bun inflates a buffered body in one chunk, past any cap; the bytes are inflated here instead.
		decompress: false,
		signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
	} as RequestInit)
	const how = reading(res, path)
	if (how instanceof AspError) {
		await res.body?.cancel()
		throw how
	}
	const raw = res.body ? await readCapped(res.body, path) : Buffer.alloc(0)
	if (!how.inflate) return decode(raw)
	try {
		return decode(how.inflate(raw, { maxOutputLength: MAX_BODY_BYTES }))
	} catch (e) {
		throw codeOf(e) === TOO_LARGE ? tooLarge(path) : new AspError(`${path}: the answer could not be inflated`)
	}
}

/**
 * One GET carrying the bot's User-Agent. A redirect fails, so one call is one request to this host with its
 * query. The deadline covers the whole body, which is cut off at {@link MAX_BODY_BYTES} before and after
 * inflating. Every failure is an {@link AspError} with a fixed message.
 */
async function getText(aspApiUrl: string, path: string, scope: AspScope | undefined, o: AspRequest): Promise<string> {
	try {
		return await request(aspApiUrl, path, scope, o)
	} catch (e) {
		if (e instanceof AspError) throw e
		throw new AspError(`${path}: ${e instanceof Error && e.name === "TimeoutError" ? "timed out" : "the request failed"}`)
	}
}

/** The index of the quote closing a JSON string whose body starts at `i`, or the end of `text`. */
function stringEnd(text: string, i: number): number {
	for (; i < text.length; i++) {
		const c = text.charCodeAt(i)
		if (c === 92) i++
		else if (c === 34) return i
	}
	return i
}

function shapeExceeds(text: string): boolean {
	let commas = 0
	let opens = 0
	for (let i = 0; i < text.length; i++) {
		const c = text.charCodeAt(i)
		if (c === 34) i = stringEnd(text, i + 1)
		else if (c === 44 && ++commas > MAX_LEAVES + 16) return true
		else if ((c === 91 || c === 123) && ++opens > 16) return true
	}
	return false
}

/** The parsed body, refused first when its shape would make JSON.parse allocate past what the answer needs. */
function parse(text: string, path: string): unknown {
	if (shapeExceeds(text)) throw new AspError(`${path}: more than ${MAX_LEAVES} entries, or more than 16 containers`)
	try {
		return JSON.parse(text)
	} catch {
		throw new AspError(`${path}: the answer is not JSON`)
	}
}

async function leavesAt(aspApiUrl: string, scope: AspScope | undefined, o: AspRequest): Promise<bigint[]> {
	const leaves = (parse(await getText(aspApiUrl, LEAVES, scope, o), LEAVES) as { leaves?: unknown } | null)?.leaves
	if (Array.isArray(leaves) && leaves.length > MAX_LEAVES) throw new AspError(`${LEAVES}: more than ${MAX_LEAVES} leaves`)
	if (!Array.isArray(leaves) || !leaves.every((l) => typeof l === "string" && DECIMAL.test(l))) {
		throw new AspError(`${LEAVES}: not a list of decimal strings`)
	}
	const out = leaves.map((l) => BigInt(l))
	if (!out.every((l) => l > 0n && l < BN254_P)) throw new AspError(`${LEAVES}: a leaf is outside [1, p)`)
	return out
}

/** The ASP API's current leaves (`GET /association-set/leaves`), in its order; the caller checks they hash to the chain's root. */
export async function fetchLeaves(aspApiUrl: string, o: AspRequest = {}): Promise<bigint[]> {
	return leavesAt(aspApiUrl, undefined, o)
}

/** {@link fetchLeaves} for one pool, named by `?chainId=&entrypoint=`; the caller checks the leaves hash to that pool's root. */
export async function fetchScopedLeaves(aspApiUrl: string, scope: AspScope, o: AspRequest = {}): Promise<bigint[]> {
	return leavesAt(aspApiUrl, scope, o)
}

/** The root the ASP API claims for one pool (`GET /association-set/root`): a decimal of at most 78 digits or `0x` with at most 64. */
export async function fetchScopedRoot(aspApiUrl: string, scope: AspScope, o: AspRequest = {}): Promise<bigint> {
	const root = (parse(await getText(aspApiUrl, ROOT, scope, o), ROOT) as { root?: unknown } | null)?.root
	if (typeof root !== "string" || !(DECIMAL.test(root) || HEX_WORD.test(root))) throw new AspError(`${ROOT}: not a decimal or 0x root`)
	return BigInt(root)
}
