// Against the live endpoint in SEPOLIA_RPC_URL: one owned fork, every pin checked, nothing left behind.
import { describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync, rmSync, statSync, truncateSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { CIRCUIT_BUNDLES } from "@pp/pool-client"
import { BUNDLE, bundleDir, CIRCUITS, checkBundleDir } from "../src/bundle.ts"
import { PINS, type Pins } from "../src/pins.ts"
import { PreflightError } from "../src/preflight.ts"
import { runFork } from "../src/run.ts"

const endpoint = process.env.SEPOLIA_RPC_URL || undefined
delete process.env.SEPOLIA_RPC_URL

const lines: string[] = []
const log = (line: string) => {
	lines.push(line)
	process.stderr.write(`sepolia-fork: ${line}\n`)
}

const failure = async (pins: Pins) => {
	const err = await runFork({ endpoint: endpoint!, pins, log }).then(
		() => undefined,
		(e: unknown) => e,
	)
	expect(err).toBeInstanceOf(PreflightError)
	return err as PreflightError
}

describe.skipIf(!endpoint)("the Sepolia fork", () => {
	test("starts at the pinned block, holds every pin, and tears down to nothing", async () => {
		const seen: string[] = []
		const report = await runFork({
			endpoint: endpoint!,
			log,
			body: async (fork) => {
				seen.push(await fork.rpc<string>("web3_clientVersion"))
			},
		})
		expect(seen).toEqual(["anvil/v1.7.1"])
		expect(report.finalized).toBeGreaterThan(PINS.block.number)
		expect(report.leftovers).toEqual({ groups: 0, rows: 0, dirs: 0 })
		expect(lines.join("\n")).not.toContain(new URL(endpoint!).pathname.length > 1 ? new URL(endpoint!).pathname : "\0")
	})

	test("a mutated Inbox pin fails on the fork, naming the pin", async () => {
		const err = await failure({ ...PINS, bindings: { ...PINS.bindings, inbox: "0x0000000000000000000000000000000000000001" } })
		expect([err.kind, err.pins]).toEqual(["pin", ["inbox"]])
		expect(lines.at(-1)).toBe("teardown: groups=0 rows=0 dirs=0")
	})

	test("a mutated block hash fails before anything forks, naming the pin", async () => {
		const err = await failure({ ...PINS, block: { ...PINS.block, hash: `0x${"00".repeat(32)}` } })
		expect([err.kind, err.pins]).toEqual(["pin", ["block.hash"]])
		expect(lines.at(-1)).toBe("teardown: groups=0 rows=0 dirs=0")
	})
})

const SDK_TARBALL = "https://registry.npmjs.org/@0xbow/privacy-pools-v2-sdk/-/privacy-pools-v2-sdk-1.0.0.tgz"
const SDK_TARBALL_SHA256 = "c20f251e4813b4db354010521f042d1b9de84115ac230cbd63591e106a763a2d"

/** Each circuit's entry in the `DEFAULT_CIRCUIT_MANIFEST` object literal of the SDK's built `index.js`. */
function manifestOf(source: string): Record<string, Record<string, string>> {
	const start = source.indexOf("DEFAULT_CIRCUIT_MANIFEST = {")
	const literal = source.slice(start, source.indexOf("\n};", start))
	const out: Record<string, Record<string, string>> = {}
	for (const [, name, body] of literal.matchAll(/^ {2}(\w+): \{([^}]*)\}/gm))
		out[name ?? ""] = Object.fromEntries([...(body ?? "").matchAll(/(\w+): "([^"]+)"/g)].map(([, k, v]) => [k, v]))
	return out
}

describe.skipIf(!endpoint)("the pre-ceremony bundle", () => {
	test("is the manifest SDK 1.0.0 published on npm, digest for digest", async () => {
		const tarball = new Uint8Array(await (await fetch(SDK_TARBALL, { redirect: "error" })).arrayBuffer())
		expect(new Bun.CryptoHasher("sha256").update(tarball).digest("hex")).toBe(SDK_TARBALL_SHA256)
		const files = await new Bun.Archive(tarball).files()
		const manifest = manifestOf((await files.get("package/dist/index.js")?.text()) ?? "")
		for (const circuit of CIRCUITS) {
			const { sizes: _, ...pins } = CIRCUIT_BUNDLES[BUNDLE].circuits[circuit]
			expect(manifest[circuit]).toEqual({ ...pins })
		}
	})

	test("comes from the public gateways at pool-client's pins, and a cached file one byte short is refused by name", async () => {
		const dir = await bundleDir({ log })
		const copy = mkdtempSync(join(homedir(), ".cache/pp/fork/bundle-net-"))
		try {
			cpSync(dir, copy, { recursive: true })
			const key = join(copy, "transact_1x1", "groth16_pkey.zkey")
			truncateSync(key, statSync(key).size - 1)
			await expect(checkBundleDir(copy)).rejects.toMatchObject({
				code: "ARTIFACT_MISMATCH",
				message: expect.stringContaining("transact_1x1 provingKey"),
			})
		} finally {
			rmSync(copy, { recursive: true, force: true })
		}
	})
})
