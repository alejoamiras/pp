/**
 * Where one running stack lives: its two chains, the pool and, once their lanes write them, the
 * bridge, the bot and the served artifacts. Pure and isomorphic; writers and readers do their own IO.
 *
 * Attaching is not proof of life: a manifest can outlive the stack that wrote it, so a consumer
 * checks the L1 chain id and the code at the manifest's addresses before trusting them.
 */
import type { Address, Hex } from "viem"
import z from "zod"

const LOCAL_CHAIN_ID = 31337
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

const evmAddress = z
	.string()
	.regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte 0x hex address")
	.transform((a) => a as Address)
const aztecAddress = z
	.string()
	.regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32-byte 0x hex address")
	.transform((a) => a as Hex)
/** JSON has no bigint, and a JSON number loses precision past 2^53, so bigints travel as decimal strings. */
const decimalBigint = z
	.string()
	.regex(/^(0|[1-9][0-9]*)$/, "expected a non-negative decimal string")
	.transform((s) => BigInt(s))
const httpUrl = z.url({ protocol: /^https?$/, error: "expected an http(s) URL" })

const poolSchema = z
	.object({
		poolVault: evmAddress,
		entrypoint: evmAddress,
		aspRegistry: evmAddress,
		keystore: evmAddress,
		asset: evmAddress,
		deployBlock: decimalBigint,
		aspApiUrl: httpUrl,
	})
	.strict()

const bridgeSchema = z
	.object({
		factory: evmAddress,
		portal: evmAddress,
		hub: aztecAddress,
		token: aztecAddress,
		registry: aztecAddress,
		deployBlock: decimalBigint,
	})
	.strict()

const botSchema = z.object({ url: httpUrl, poster: aztecAddress, birthIntake: aztecAddress }).strict()

const artifactsSchema = z.object({ baseUrl: httpUrl }).strict()

/** A local chain is reachable only from this host, so a manifest pointing it elsewhere is a mistake or a redirect. */
function urlsOf(m: {
	l1Rpc: string
	aztecNode: string
	pool: { aspApiUrl: string }
	bot?: { url: string }
	artifacts?: { baseUrl: string }
}) {
	return [
		{ path: ["l1Rpc"], url: m.l1Rpc },
		{ path: ["aztecNode"], url: m.aztecNode },
		{ path: ["pool", "aspApiUrl"], url: m.pool.aspApiUrl },
		...(m.bot ? [{ path: ["bot", "url"], url: m.bot.url }] : []),
		...(m.artifacts ? [{ path: ["artifacts", "baseUrl"], url: m.artifacts.baseUrl }] : []),
	]
}

export const stackManifestSchema = z
	.object({
		version: z.literal(1),
		chainId: z.number().int().positive(),
		l1Rpc: httpUrl,
		aztecNode: httpUrl,
		pool: poolSchema,
		bridge: bridgeSchema.optional(),
		bot: botSchema.optional(),
		artifacts: artifactsSchema.optional(),
	})
	.strict()
	.superRefine((m, ctx) => {
		if (m.chainId !== LOCAL_CHAIN_ID) return
		for (const { path, url } of urlsOf(m)) {
			// The field's own check already reported a URL that does not parse.
			if (!URL.canParse(url)) continue
			const u = new URL(url)
			if (u.protocol !== "http:" || !LOOPBACK_HOSTS.has(u.hostname))
				ctx.addIssue({ code: "custom", path, message: `chain ${LOCAL_CHAIN_ID} needs a loopback http URL, got ${url}` })
		}
	})

export type StackManifest = z.output<typeof stackManifestSchema>
export type StackBlock = "bridge" | "bot" | "artifacts"

/**
 * Validates a decoded manifest (the value of `JSON.parse`, not the text).
 * @throws Error naming every offending field: an unknown key, a wrong type, a bigint not written as
 *   a decimal string, a malformed address, or a non-loopback URL on chain 31337.
 */
export function parseStackManifest(json: unknown): StackManifest {
	const result = stackManifestSchema.safeParse(json)
	if (!result.success) {
		const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
		throw new Error(`stack manifest failed strict validation — ${issues}`)
	}
	return result.data
}

/** Tab-indented JSON with a trailing newline; validates first, so it never writes what `parseStackManifest` would refuse. */
export function serializeStackManifest(m: StackManifest): string {
	const text = `${JSON.stringify(m, (_key, v) => (typeof v === "bigint" ? v.toString() : v), "\t")}\n`
	parseStackManifest(JSON.parse(text))
	return text
}

/**
 * Narrows a manifest to one that carries `blocks`, for a consumer that cannot run without them.
 * @throws Error naming every missing block.
 */
export function requireBlocks<K extends StackBlock>(
	m: StackManifest,
	blocks: readonly K[],
): StackManifest & Required<Pick<StackManifest, K>> {
	const missing = blocks.filter((b) => m[b] === undefined)
	if (missing.length) throw new Error(`stack manifest has no ${missing.join(", ")} block${missing.length > 1 ? "s" : ""}`)
	return m as StackManifest & Required<Pick<StackManifest, K>>
}
