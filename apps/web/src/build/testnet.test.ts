import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseStackManifest } from "@pp/bridge-core/stack-manifest"
import { parseDeployment } from "@pp/testnet/schema"
import { afterAll, describe, expect, test } from "vitest"
import { scratchDir } from "../../scripts/proc"
import { resolveSameOrigin } from "./same-origin"
import { sponsoredFpcAddress } from "./sponsored-fpc"
import { testnetTarget } from "./testnet"

const FIXTURE = join(import.meta.dirname, "fixtures", "testnet-own.json")
/** The same made-up pool and bridge, as the operator's pool1. */
const POOL1 = join(import.meta.dirname, "fixtures", "testnet-pool1.json")
const FPC = "0x2d8fff82a3b0c15d0a89169e7d8d043e079ab94d52031f1de1e4972ebad169d3"
/** The fixture as plain JSON; an edit sets a section to `undefined` to drop it from the written file. */
type Draft = {
	[k: string]: unknown
	network: Record<string, unknown>
	pool?: Record<string, unknown>
	bridge?: unknown
	expected: Record<string, unknown>
}
const base = (from = FIXTURE): Draft => JSON.parse(readFileSync(from, "utf8"))
/** Every string under `v`, hex without its prefix: each is a value the fixture makes distinct. */
const leaves = (v: unknown): string[] =>
	typeof v === "string" ? [v.replace(/^0x/, "")] : typeof v === "object" && v !== null ? Object.values(v).flatMap(leaves) : []

const dir = scratchDir("testnet-target")
afterAll(() => rmSync(dir, { recursive: true, force: true }))
let n = 0
function file(edit: (d: Draft) => void, from = FIXTURE): string {
	const d = base(from)
	edit(d)
	const path = join(dir, `deployment-${n++}.json`)
	writeFileSync(path, JSON.stringify(d))
	return path
}

describe("testnetTarget", () => {
	test("is exactly the file's public fields, with the ASP and the bot behind the page's origin", () => {
		expect(testnetTarget(FIXTURE, {}, FPC)).toEqual({
			nodeUrl: "https://aztec-testnet.drpc.org",
			l1RpcUrl: "https://sepolia.gateway.tenderly.co",
			l1ChainId: 11155111,
			rollupVersion: 679261766,
			walletUrls: [],
			dataMode: "stack",
			connector: "real",
			stack: {
				manifest: {
					version: 1,
					chainId: 11155111,
					l1Rpc: "https://sepolia.gateway.tenderly.co",
					aztecNode: "https://aztec-testnet.drpc.org",
					pool: {
						poolVault: "0x1000000000000000000000000000000000000001",
						entrypoint: "0x1000000000000000000000000000000000000002",
						aspRegistry: "0x1000000000000000000000000000000000000003",
						keystore: "0x1000000000000000000000000000000000000004",
						asset: "0x1000000000000000000000000000000000000005",
						deployBlock: "9700000",
						aspApiUrl: "/asp",
					},
					bridge: {
						factory: "0x2000000000000000000000000000000000000001",
						portal: "0x2000000000000000000000000000000000000002",
						hub: "0x2000000000000000000000000000000000000000000000000000000000000003",
						token: "0x2000000000000000000000000000000000000000000000000000000000000004",
						registry: "0x2000000000000000000000000000000000000000000000000000000000000005",
						deployBlock: "9700100",
					},
				},
				botUrl: "/bot",
				sponsoredFpc: FPC,
				demoSender: null,
			},
		})
	})

	test("resolves in the page to a manifest the adapters accept", () => {
		const t = resolveSameOrigin(testnetTarget(FIXTURE, {}, FPC), "http://localhost:28600")
		expect(parseStackManifest(t.stack?.manifest).pool.aspApiUrl).toBe("http://localhost:28600/asp")
	})

	test("carries nothing from the expected section or the description", () => {
		const text = JSON.stringify(testnetTarget(FIXTURE, {}, FPC)).toLowerCase()
		for (const leaf of leaves([base().expected, base().description])) expect(text, leaf).not.toContain(leaf.toLowerCase())
		// The loopback ports stay with the server: the page reaches them through its own origin.
		expect(text).not.toContain("4860")
	})

	test("refuses any other target, chain, endpoint or fee contract, and an incomplete file", () => {
		const refusals: [string, (d: Draft) => void, RegExp][] = [
			["operator section", (d) => (d.operator = {}), /operator/],
			["local chain", (d) => (d.network.l1ChainId = 31337), /Sepolia/],
			["unpinned L1 RPC", (d) => (d.network.l1Rpc = "https://rpc.example"), /pinned Sepolia RPC/],
			["unpinned L1 send RPC", (d) => (d.network.l1SendRpc = "https://sepolia.gateway.tenderly.co"), /pinned Sepolia send RPC/],
			["unpinned node", (d) => (d.network.aztecNode = "https://node.example"), /pinned testnet node/],
			["other FPC", (d) => (d.network.fpc = `0x${"11".repeat(32)}`), /canonical SponsoredFPC/],
			["no bridge", (d) => (d.bridge = undefined), /bridge/],
			["no pool", (d) => (d.pool = undefined), /pool/],
			["ASP off loopback", (d) => (d.pool = { ...d.pool, aspApiUrl: "https://asp.example" }), /aspApiUrl/],
		]
		for (const [what, edit, message] of refusals) expect(() => testnetTarget(file(edit), {}, FPC), what).toThrow(message)
		expect(() => testnetTarget(join(dir, "absent.json"), {}, FPC)).toThrow(/cannot be read/)
		// The schema knows no target but own and pool1, so it refuses another before the build's own rule.
		expect(() =>
			testnetTarget(
				file((d) => (d.target = "v9"), POOL1),
				{},
				FPC,
			),
		).toThrow(/target: Invalid option/)
	})

	test("takes pool1 with its ASP behind the page's origin, and only with the ceremony bundle", () => {
		const entrypoint = base(POOL1).pool?.entrypoint
		expect(testnetTarget(POOL1, {}, FPC)).toEqual(
			testnetTarget(
				file((d) => (d.pool = { ...d.pool, entrypoint })),
				{},
				FPC,
			),
		)
		const standIn = file((d) => (d.pool = { ...d.pool, aspApiUrl: "http://127.0.0.1:9000" }), POOL1)
		expect(() => testnetTarget(standIn, {}, FPC)).toThrow(/operator's pinned ASP API/)
		const preCeremony = join(dir, `deployment-${n++}.json`)
		writeFileSync(preCeremony, JSON.stringify({ ...JSON.parse(readFileSync(POOL1, "utf8")), bundle: "pre-ceremony" }))
		expect(() => testnetTarget(preCeremony, {}, FPC)).toThrow(/ceremony bundle the app pins/)
	})

	test("reads PP_DEPLOYMENT alone", () => {
		expect(() => testnetTarget(undefined, {}, FPC)).toThrow(/PP_DEPLOYMENT is not set/)
		for (const name of ["PP_STACK_MANIFEST", "PP_SANDBOX_ARTIFACTS", "PP_DATA", "PP_WEB_WALLETS"])
			for (const value of ["x", ""])
				expect(() => testnetTarget(FIXTURE, { [name]: value }, FPC), name).toThrow(new RegExp(`${name} is set`))
	})
})

test("every committed deployment file parses under the schema the build reads them with", () => {
	const committed = join(import.meta.dirname, "../../../../packages/testnet/deployments")
	const files = readdirSync(committed).filter((f) => f.endsWith(".json"))
	expect(files.length).toBeGreaterThan(0)
	for (const f of [...files.map((f) => join(committed, f)), FIXTURE])
		expect(() => parseDeployment(JSON.parse(readFileSync(f, "utf8"))), f).not.toThrow()
})

test("the fixture names the SponsoredFPC the build derives", async () => {
	expect(base().network.fpc).toBe(await sponsoredFpcAddress())
}, 60_000)
