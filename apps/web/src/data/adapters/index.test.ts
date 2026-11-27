import { beforeEach, expect, test, vi } from "vitest"
import type { DataSource } from "../source"
import type { AztecAddress } from "../stack-types"

vi.mock("../../target", () => ({
	target: {
		nodeUrl: "http://127.0.0.1:8080",
		stack: {
			manifest: {
				chainId: 31337,
				l1Rpc: "http://127.0.0.1:8545",
				bridge: {
					portal: `0x${"11".repeat(20)}`,
					hub: `0x${"0".repeat(62)}22`,
					token: `0x${"0".repeat(62)}33`,
					registry: `0x${"0".repeat(62)}44`,
					factory: `0x${"55".repeat(20)}`,
				},
				pool: { asset: `0x${"66".repeat(20)}` },
			},
			sponsoredFpc: `0x${"0".repeat(62)}77`,
			demoSender: null,
			botUrl: "http://127.0.0.1:9",
		},
	},
}))
vi.mock("./l1", () => ({ stackL1: () => ({ reads: {} }) }))
vi.mock("./clock", () => ({ stackClock: () => ({}) }))
vi.mock("./token", () => ({ readToken: async () => ({ decimals: 18, symbol: "T" }) }))

/** Each lazily loaded chunk, as the page would get it once its fetch succeeds. */
const CHUNKS: Record<string, { path: string; module: Record<string, unknown> }> = {
	aztec: {
		path: "./aztec",
		module: {
			aztecDeps: () => ({ node: {} }),
			stackAztec: () => ({ notesByLabel: async () => [5n] }),
			readReceipt: async () => ({ status: "success" }),
		},
	},
	"token-sends": { path: "./token-sends", module: { stackTokenSends: () => ({ shield: async () => ({ status: "success" }) }) } },
	session: {
		path: "./session",
		module: {
			proverFor: () => ({}),
			stackSessions: () => ({ forget: async () => "forgotten" }),
			exitClient: () => ({}),
			stackExits: () => ({ tickets: async () => [] }),
			stackWithdraw: () => ({}),
		},
	},
	"allow-list": {
		path: "./allow-list",
		module: { browserWorker: {}, stackAllowList: () => ({ current: async () => "record", onProgress: () => () => {} }) },
	},
	connector: { path: "../wallet/connector", module: { createRealConnector: () => ({ current: () => null }) } },
}

const failing = new Set<string>()

// A fresh page per case: `resetModules` alone keeps a mocked chunk once it loaded, so each is registered again.
beforeEach(() => {
	failing.clear()
	vi.resetModules()
	for (const [name, { path, module }] of Object.entries(CHUNKS))
		vi.doMock(path, () => {
			if (failing.has(name)) throw new TypeError(`Failed to fetch dynamically imported module: ${name}`)
			return module
		})
	vi.stubGlobal("location", { origin: "http://127.0.0.1:5173" })
	vi.stubGlobal("localStorage", {})
})

const OWNER = `0x${"0".repeat(62)}aa` as AztecAddress
const TX = `0x${"ab".repeat(32)}` as const

test.each([
	{ chunk: "aztec", read: "a label's notes", call: (s: DataSource) => s.aztec.notesByLabel(OWNER, 1n), loaded: [5n] },
	{ chunk: "aztec", read: "a receipt", call: (s: DataSource) => s.receipts.aztec(TX), loaded: { status: "success" } },
	{
		chunk: "token-sends",
		read: "a shield",
		call: (s: DataSource) => s.aztec.shield(OWNER, 1n, {} as never),
		loaded: { status: "success" },
	},
	{ chunk: "session", read: "the sessions", call: (s: DataSource) => s.sessions.forget(), loaded: "forgotten" },
	{ chunk: "session", read: "the exit tickets", call: (s: DataSource) => s.exits.tickets(`0x${"99".repeat(20)}`), loaded: [] },
	{ chunk: "allow-list", read: "the allow list", call: (s: DataSource) => s.allowList.current(), loaded: "record" },
	{ chunk: "connector", read: "the wallet connector", call: (s: DataSource) => s.wallet(), loaded: { current: expect.any(Function) } },
])("$read: a $chunk chunk that fails to load reads PAGE_LOAD_FAILED, and the next call loads it", async ({ chunk, call, loaded }) => {
	const source = await (await import("./index")).loadSource()
	failing.add(chunk)
	await expect(call(source)).rejects.toMatchObject({ name: "BridgeFailure", code: "PAGE_LOAD_FAILED" })
	failing.delete(chunk)
	await expect(call(source)).resolves.toEqual(loaded)
})
