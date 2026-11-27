import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "vitest"
import { bunRun, envWithout, scratchDir } from "../../scripts/proc"
import { type PublicTarget, resolveTarget, type TargetEnv } from "./target"

/** One distinct value per field the handle holds but the bundle must never carry. */
const SENTINELS = {
	deployerKey: `0x${"5e01".repeat(16)}`,
	actorKey0: `0x${"5e02".repeat(16)}`,
	actorKey1: `0x${"5e03".repeat(16)}`,
	relayer: `0x${"5e04".repeat(16)}`,
	actorSecret: `0x${"5e05".repeat(16)}`,
	actorSalt: "5e06000000000000000000000000000000000006",
}

const WALLETS = ["http://127.0.0.1:40101/?profile=plain", "http://127.0.0.1:40102/?profile=full"]

/** The shape `sandbox:up` writes, with a sentinel in every sensitive field. */
const HANDLE = {
	anvilUrl: "http://127.0.0.1:40103",
	nodeUrl: "http://127.0.0.1:40104",
	l1ChainId: 31337,
	rollupVersion: 1685378643,
	walletChainId: 0,
	artifactsDir: ".",
	l1: { deployerKey: SENTINELS.deployerKey, actorKeys: [SENTINELS.actorKey0, SENTINELS.actorKey1] },
	l2: { relayer: SENTINELS.relayer, actorSecret: SENTINELS.actorSecret, actorSalt: SENTINELS.actorSalt },
	deployment: { registry: `0x${"00".repeat(20)}`, tokens: {} },
}

const dirs: string[] = []
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function disposable(label: string): string {
	const dir = scratchDir(label)
	dirs.push(dir)
	return dir
}

function artifacts(handle: unknown): string {
	const dir = disposable("target")
	writeFileSync(join(dir, "handle.json"), JSON.stringify(handle))
	return dir
}

const local = (env: TargetEnv) => resolveTarget({ local: true, env, committedHandle: "/nonexistent" })

const A20 = (n: string) => `0x${n.repeat(20)}`
const A32 = (n: string) => `0x${n.repeat(32)}`
const FPC = A32("fc")
/** The bot's accounts: manifest fields the page never needs, so the target must not carry them. */
const BOT_SENTINELS = { poster: A32("5e"), birthIntake: A32("5f") }

/** The shape the local stack writes. */
const MANIFEST = {
	version: 1,
	chainId: 31337,
	l1Rpc: "http://127.0.0.1:40105",
	aztecNode: "http://127.0.0.1:40106",
	pool: {
		poolVault: A20("01"),
		entrypoint: A20("02"),
		aspRegistry: A20("03"),
		keystore: A20("04"),
		asset: A20("05"),
		deployBlock: "12",
		aspApiUrl: "http://127.0.0.1:40107",
	},
	bridge: { factory: A20("06"), portal: A20("07"), hub: A32("08"), token: A32("09"), registry: A32("0a"), deployBlock: "34" },
	bot: { url: "http://127.0.0.1:40108", ...BOT_SENTINELS },
}

function manifestFile(manifest: unknown): string {
	const file = join(disposable("manifest"), "manifest.json")
	writeFileSync(file, JSON.stringify(manifest))
	return file
}

const stack = (manifest: unknown, sponsoredFpc: string | null = FPC) =>
	resolveTarget({
		local: true,
		env: { PP_STACK_MANIFEST: manifestFile(manifest), PP_WEB_WALLETS: WALLETS.join(",") },
		committedHandle: "/nonexistent",
		...(sponsoredFpc === null ? {} : { sponsoredFpc }),
	})

function filesUnder(dir: string): string[] {
	return (readdirSync(dir, { recursive: true, withFileTypes: true }) as { isFile(): boolean; parentPath: string; name: string }[])
		.filter((e) => e.isFile())
		.map((e) => join(e.parentPath, e.name))
}

describe("the build target", () => {
	test("carries exactly the allow-listed fields of the sandbox handle", () => {
		const t = local({ PP_SANDBOX_ARTIFACTS: artifacts(HANDLE), PP_WEB_WALLETS: WALLETS.join(",") })
		expect(t).toEqual({
			nodeUrl: HANDLE.nodeUrl,
			l1RpcUrl: HANDLE.anvilUrl,
			l1ChainId: 31337,
			rollupVersion: 1685378643,
			walletUrls: WALLETS,
			dataMode: "fixtures",
			connector: "real",
			stack: null,
		} satisfies PublicTarget)
		for (const value of Object.values(SENTINELS)) expect(JSON.stringify(t)).not.toContain(value)
		const committed = resolveTarget({ local: false, env: {}, committedHandle: join(artifacts(HANDLE), "handle.json") })
		expect([committed.connector, committed.walletUrls]).toEqual(["fixture", []])
	})

	test("carries exactly the public fields of a stack manifest, and the node's rollup version is left to the page", () => {
		const t = stack(MANIFEST)
		expect(t).toEqual({
			nodeUrl: MANIFEST.aztecNode,
			l1RpcUrl: MANIFEST.l1Rpc,
			l1ChainId: 31337,
			rollupVersion: null,
			walletUrls: WALLETS,
			dataMode: "stack",
			connector: "real",
			stack: {
				manifest: {
					version: 1,
					chainId: 31337,
					l1Rpc: MANIFEST.l1Rpc,
					aztecNode: MANIFEST.aztecNode,
					pool: MANIFEST.pool,
					bridge: MANIFEST.bridge,
				},
				botUrl: MANIFEST.bot.url,
				sponsoredFpc: FPC,
				demoSender: null,
			},
		} satisfies PublicTarget)
		for (const value of Object.values(BOT_SENTINELS)) expect(JSON.stringify(t)).not.toContain(value.slice(2))
	})

	test("carries the demo sender only on chain 31337 over a loopback L1 RPC, and only a checksummed one", () => {
		const SENDER = "0xFABB0ac9d68B0B445fB7357272Ff202C5651694a"
		const withSender = (manifest: unknown, demoSender: string) =>
			resolveTarget({
				local: true,
				env: { PP_STACK_MANIFEST: manifestFile(manifest), PP_WEB_WALLETS: WALLETS.join(",") },
				committedHandle: "/nonexistent",
				sponsoredFpc: FPC,
				demoSender,
			}).stack?.demoSender
		const remote = {
			...MANIFEST,
			chainId: 11155111,
			l1Rpc: "https://rpc.example",
			aztecNode: "https://node.example",
			pool: { ...MANIFEST.pool, aspApiUrl: "https://asp.example" },
			bot: { ...MANIFEST.bot, url: "https://bot.example" },
		}
		expect(withSender(MANIFEST, SENDER)).toBe(SENDER)
		expect(withSender(remote, SENDER)).toBeNull()
		expect(() => withSender(MANIFEST, SENDER.toLowerCase())).toThrow(/demo sender/)
	})

	test("refuses a stack manifest the schema, the target's URL rule or the build mode does not accept", () => {
		const remote = { ...MANIFEST, chainId: 11155111, l1Rpc: "https://key@rpc.example", aztecNode: "https://node.example" }
		const { bot: _bot, ...botless } = MANIFEST
		const cases: [string, () => unknown][] = [
			[
				"no manifest file",
				() => local({ PP_STACK_MANIFEST: join(disposable("empty"), "manifest.json"), PP_WEB_WALLETS: WALLETS[0] }),
			],
			["a non-loopback node on 31337", () => stack({ ...MANIFEST, aztecNode: "http://10.0.0.1:8080" })],
			["an unknown field", () => stack({ ...MANIFEST, keys: ["0x01"] })],
			["no bot block", () => stack(botless)],
			["an L1 RPC URL with a key in its userinfo", () => stack(remote)],
			["no SponsoredFPC address", () => stack(MANIFEST, null)],
			["a SponsoredFPC address that is not 32-byte hex", () => stack(MANIFEST, A20("fc"))],
			["PP_DATA=fixtures beside a manifest", () => local({ PP_STACK_MANIFEST: manifestFile(MANIFEST), PP_DATA: "fixtures" })],
			["PP_DATA=stack with no manifest", () => local({ PP_DATA: "stack", PP_WEB_WALLETS: WALLETS[0] })],
		]
		for (const [label, run] of cases) expect(run, label).toThrow(/build target/)
		const committed = { local: false, env: { PP_STACK_MANIFEST: manifestFile(MANIFEST) }, committedHandle: "/x", sponsoredFpc: FPC }
		expect(() => resolveTarget(committed)).toThrow(/real connector/)
	})

	test("refuses a missing or invalid input", () => {
		const ok = { PP_SANDBOX_ARTIFACTS: artifacts(HANDLE), PP_WEB_WALLETS: WALLETS[0] }
		const withHandle = (patch: object) => ({ ...ok, PP_SANDBOX_ARTIFACTS: artifacts({ ...HANDLE, ...patch }) })
		const cases: [string, TargetEnv][] = [
			["no artifacts", { PP_WEB_WALLETS: WALLETS[0] }],
			["no handle.json", { ...ok, PP_SANDBOX_ARTIFACTS: disposable("empty") }],
			["no wallets", { ...ok, PP_WEB_WALLETS: " , " }],
			["a wallet URL with credentials", { ...ok, PP_WEB_WALLETS: "http://u:p@127.0.0.1:1/" }],
			["two wallets on one origin", { ...ok, PP_WEB_WALLETS: "http://127.0.0.1:1/?a,http://127.0.0.1:1/?b" }],
			["a node URL that is not http", withHandle({ nodeUrl: "ws://127.0.0.1:1" })],
			["an L1 RPC URL with a key in its userinfo", withHandle({ anvilUrl: "https://key@rpc.example" })],
			["a wildcard wallet host, which a CSP source reads as any host", { ...ok, PP_WEB_WALLETS: "https://*" }],
			["a wildcard subdomain node host", withHandle({ nodeUrl: "https://*.example" })],
			["a percent-encoded wildcard host", withHandle({ anvilUrl: "https://rpc%2A.example" })],
			["a chain id that is not a number", withHandle({ l1ChainId: "31337" })],
			["a negative rollup version", withHandle({ rollupVersion: -1 })],
			["an unknown data mode", { ...ok, PP_DATA: "mock" }],
			["a testnet deployment file", { ...ok, PP_DEPLOYMENT: "/deployments/testnet-own.json" }],
		]
		for (const [label, env] of cases) expect(() => local(env), label).toThrow(/build target/)
		const fixtureBuild = { local: false, env: { PP_DEPLOYMENT: "" }, committedHandle: join(artifacts(HANDLE), "handle.json") }
		expect(() => resolveTarget(fixtureBuild), "an empty one, in a fixture build").toThrow(/PP_DEPLOYMENT/)
	})

	// The kit's own path: `build:local` reads the handle, then every output file is scanned.
	test("build:local output names the node and the wallets, and no sensitive handle field", async () => {
		const dir = artifacts(HANDLE)
		const outDir = join(dir, "dist")
		const env = { ...envWithout(), PP_SANDBOX_ARTIFACTS: dir, PP_WEB_WALLETS: WALLETS.join(",") }
		const build = bunRun(["build:local", "--", "--outDir", outDir], { env, capture: true })
		const code = await build.exited
		await build.stop()
		expect(code, build.output()).toBe(0)
		const files = filesUnder(outDir)
		const text = files.map((f) => readFileSync(f, "latin1")).join("\n")
		for (const url of [HANDLE.nodeUrl, ...WALLETS]) expect(text, `the bundle names ${url}`).toContain(url)
		for (const [field, value] of Object.entries(SENTINELS)) expect(text.includes(value), `${field} leaked into ${outDir}`).toBe(false)
		expect(files.some((f) => f.endsWith(".map"))).toBe(false)
	}, 90_000)
})
