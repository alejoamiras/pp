/**
 * The testnet deployment file: one per target, one writer per section. `network` is the only source of
 * transport and rollup fields; `expected` is committed before a deploy and never read from the chain;
 * `pool` and `bridge` are promoted from a keyed run's candidate.
 */
import z from "zod"
import { isPinned, LOCAL, loopback, SEPOLIA } from "./network.ts"

export type { PinnedKind } from "./network.ts"
export { isPinned, PINNED_URLS } from "./network.ts"

// viem's shapes, declared here so the entry needs no viem, even for types.
type Address = `0x${string}`
type Hex = `0x${string}`

/** Every address field names an account or a contract, so none of them may be zero. */
const evmAddress = z
	.string()
	.regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte 0x hex address")
	.refine((a) => !/^0x0{40}$/.test(a), "the zero address names no account or contract")
	.transform((a) => a as Address)
const word = z
	.string()
	.regex(/^0x[0-9a-fA-F]{64}$/, "expected a 32-byte 0x hex word")
	.transform((a) => a as Hex)
const selector = z
	.string()
	.regex(/^0x[0-9a-fA-F]{8}$/, "expected a 4-byte 0x hex selector")
	.transform((a) => a as Hex)
/** JSON has no bigint, and a JSON number loses precision past 2^53, so bigints travel as decimal strings. */
const decimal = z
	.string()
	.regex(/^(0|[1-9][0-9]*)$/, "expected a non-negative decimal string")
	.transform((s) => BigInt(s))
const port = z.number().int().min(1024).max(65_535)
const url = z.url({ protocol: /^https?$/, error: "expected an http(s) URL" })

/** Transport is checked per mode by `assertTransport`: pinned URLs on Sepolia, loopback in a rehearsal. */
const networkSchema = z
	.object({
		l1ChainId: z.union([z.literal(SEPOLIA), z.literal(LOCAL)]),
		rollup: evmAddress,
		l1Registry: evmAddress,
		inbox: evmAddress,
		outbox: evmAddress,
		rollupVersion: z.number().int().positive(),
		fpc: word,
		l1Rpc: url,
		/** Where every keyed L1 send goes; reads stay on `l1Rpc`. Required live; a rehearsal defaults it to `l1Rpc`. */
		l1SendRpc: url.optional(),
		aztecNode: url,
		/** The bot's snapshot server, on loopback. */
		botPort: port,
		/** The own pool's mock ASP, on loopback; operator targets use the operator's API. */
		aspPort: port.optional(),
	})
	.strict()

/** `shield`, the canary's shield in base units, defaults to 1 and must not exceed `bridge`. */
const amountsSchema = z.object({ debit: decimal, note: decimal, bridge: decimal, shield: decimal.optional() }).strict()

const expectedSchema = z
	.object({
		guardian: evmAddress,
		lifetimeCap: decimal,
		l1Deployer: evmAddress,
		l2Deployer: word,
		botPoster: word,
		aspPostman: evmAddress.optional(),
		/** The own pool's deployer; an operator target has none. */
		poolDeployer: evmAddress.optional(),
		canaryOwner: evmAddress,
		canarySender: evmAddress,
		/** The owner's hand-test accounts, which no canary step signs with. */
		demoOwner: evmAddress.optional(),
		demoSender: evmAddress.optional(),
		/** Zero keeps shields paused. */
		birthIntake: word,
		tokenClassId: word,
		amounts: amountsSchema,
	})
	.strict()

const routeSchema = z.object({ verifier: evmAddress, selector, codeHash: word }).strict()

const operatorSchema = z
	.object({
		implementation: evmAddress,
		implementationCodeHash: word,
		depositRoute: routeSchema,
		transactRoute1x1: routeSchema,
		asset: z.object({ address: evmAddress, vettingFeeBps: z.number().int().min(0).max(10_000), minDeposit: decimal }).strict(),
		evidence: z.object({ forkBlock: z.number().int().positive(), forkBlockHash: word }).strict(),
	})
	.strict()

const poolSchema = z
	.object({
		poolVault: evmAddress,
		entrypoint: evmAddress,
		aspRegistry: evmAddress,
		keystore: evmAddress,
		asset: evmAddress,
		deployBlock: decimal,
		aspApiUrl: z.string(),
		/** The own pool's, which `verify-deployment --pool-only` checks against the build; an operator's pool has none here. */
		accessRouter: evmAddress.optional(),
		relay: evmAddress.optional(),
	})
	.strict()

const bridgeSchema = z
	.object({
		factory: evmAddress,
		portal: evmAddress,
		hub: word,
		token: word,
		registry: word,
		deployBlock: decimal,
		/** The factory's creation transaction, from the deploy journal. */
		factoryTx: word,
	})
	.strict()

/** What a candidate section may carry: exactly its schema's fields. */
export const POOL_FIELDS: readonly string[] = Object.keys(poolSchema.shape)
export const BRIDGE_FIELDS: readonly string[] = Object.keys(bridgeSchema.shape)

/** `pool1` is the operator's poolId 1, which the operator's own app calls "V8". */
export const TARGETS = ["own", "pool1"] as const

export const deploymentSchema = z
	.object({
		/** Free text for whoever edits the file next; no command reads it. */
		description: z.string().max(2_000).optional(),
		network: networkSchema,
		target: z.enum(TARGETS),
		bundle: z.enum(["ceremony", "pre-ceremony"]),
		expected: expectedSchema.optional(),
		operator: operatorSchema.optional(),
		pool: poolSchema.optional(),
		bridge: bridgeSchema.optional(),
	})
	.strict()
	.superRefine((d, ctx) => {
		const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message })
		if (d.target === "own") ownIssues(d, issue)
		else if (d.pool && !isPinned("aspApi", d.pool.aspApiUrl))
			issue(["pool", "aspApiUrl"], `not this target's ASP URL: ${d.pool.aspApiUrl}`)
	})

type Draft = {
	bundle: string
	operator?: unknown
	network: { l1ChainId: number; aspPort?: number | undefined }
	expected?: { aspPostman?: string | undefined; poolDeployer?: string | undefined } | undefined
	pool?: { aspApiUrl: string; accessRouter?: string | undefined; relay?: string | undefined } | undefined
}

function ownIssues(d: Draft, issue: (path: (string | number)[], message: string) => void): void {
	if (d.network.aspPort === undefined) issue(["network", "aspPort"], "the own pool's mock ASP needs a port")
	if (d.operator) issue(["operator"], "the own pool has no operator section")
	// The own pool is pp-env's pinned build, whose verifiers carry the ceremony keys.
	if (d.bundle !== "ceremony") issue(["bundle"], "the own pool proves with the ceremony bundle")
	if (d.expected && (d.expected.aspPostman === undefined || d.expected.poolDeployer === undefined))
		issue(["expected"], "the own pool names its ASP postman and pool deployer")
	if (!d.pool) return
	// They feed the runtime-code check against the build, which runs on Sepolia only.
	if (d.network.l1ChainId === SEPOLIA && (d.pool.accessRouter === undefined || d.pool.relay === undefined))
		issue(["pool"], "the own pool names its access router and relay")
	if (d.network.aspPort === undefined || d.pool.aspApiUrl !== loopback(d.network.aspPort))
		issue(["pool", "aspApiUrl"], `not this target's ASP URL: ${d.pool.aspApiUrl}`)
}

export type TestnetDeployment = z.output<typeof deploymentSchema>
export type Section = "expected" | "operator" | "pool" | "bridge"

/**
 * Validates a decoded deployment file (the value of `JSON.parse`).
 * @throws Error naming every offending field
 */
export function parseDeployment(json: unknown): TestnetDeployment {
	const r = deploymentSchema.safeParse(json)
	if (!r.success) {
		const issues = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
		throw new Error(`deployment file failed strict validation — ${issues}`)
	}
	return r.data
}

/** The target as configured: a deployment file without the `pool` and `bridge` sections its runs add. */
export function configuredTarget<T extends { pool?: unknown; bridge?: unknown }>(d: T): Omit<T, "pool" | "bridge"> {
	const { pool: _pool, bridge: _bridge, ...target } = d
	return target
}

/** Tab-indented JSON with a trailing newline; validates first, so it never writes what `parseDeployment` refuses. */
export function serializeDeployment(d: TestnetDeployment): string {
	const text = `${JSON.stringify(d, (_k, v) => (typeof v === "bigint" ? v.toString() : v), "\t")}\n`
	parseDeployment(JSON.parse(text))
	return text
}

/**
 * Narrows to a file that carries `sections`.
 * @throws Error naming every missing section
 */
export function requireSections<K extends Section>(
	d: TestnetDeployment,
	sections: readonly K[],
): TestnetDeployment & Required<Pick<TestnetDeployment, K>> {
	const missing = sections.filter((s) => d[s] === undefined)
	if (missing.length) throw new Error(`deployment file has no ${missing.join(", ")} section${missing.length > 1 ? "s" : ""}`)
	return d as TestnetDeployment & Required<Pick<TestnetDeployment, K>>
}
