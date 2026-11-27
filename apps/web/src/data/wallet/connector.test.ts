import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import type { PendingConnection, WalletProvider } from "@aztec-labs/wallet-sdk/manager"
import { describe, expect, test, vi } from "vitest"
import type { PublicTarget } from "../../build/target"
import type { AztecAddress } from "../stack-types"
import { stageManifest } from "../capabilities"
import { createRealConnector, type Discover } from "./connector"
import { ConnectError, type WalletOption } from "./types"

const at = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as AztecAddress
const ACCOUNT = at(0x1c4f)
const MANIFEST = stageManifest("2a", { hub: at(0xa1), token: at(0xb2), sponsoredFpc: at(0xc3) })
const TARGET: PublicTarget = {
	nodeUrl: "http://127.0.0.1:8080",
	l1RpcUrl: "http://127.0.0.1:8545",
	l1ChainId: 31337,
	rollupVersion: 1,
	walletUrls: [],
	dataMode: "fixtures",
	connector: "real",
}
const PNG = "data:image/png;base64,iVBORw0KGgo="

/** A grant as the SDK returns it: the request echoed, with the accounts filled in. */
const echo = async (m: unknown) => ({
	version: "1.0",
	granted: (m as { capabilities: { type: string }[] }).capabilities.map((c) =>
		c.type === "accounts" ? { ...c, accounts: [{ alias: "a", item: { toString: () => ACCOUNT } }] } : JSON.parse(JSON.stringify(c)),
	),
	wallet: { name: "w", version: "1" },
})

interface Fake {
	provider: WalletProvider
	disconnects: number
	cancels: number
	/** Fires the SDK's remote-disconnect callback. */
	drop(): void
}

function fakeProvider(o: {
	name?: string
	icon?: unknown
	requestCapabilities?: (m: unknown) => Promise<unknown>
	hold?: Promise<void>
}): Fake {
	const fake: Fake = { provider: {} as WalletProvider, disconnects: 0, cancels: 0, drop: () => {} }
	const wallet = { requestCapabilities: o.requestCapabilities ?? echo } as unknown as Wallet
	const pending: PendingConnection = {
		verificationHash: `0x${"ab".repeat(32)}`,
		confirm: async () => {
			await o.hold
			return wallet
		},
		cancel: () => void fake.cancels++,
	}
	fake.provider = {
		id: "w",
		type: "web",
		name: o.name ?? "Wallet",
		icon: o.icon as string | undefined,
		establishSecureChannel: async () => pending,
		disconnect: async () => void fake.disconnects++,
		onDisconnect: (cb) => {
			fake.drop = cb
			return () => {
				fake.drop = () => {}
			}
		},
		isDisconnected: () => false,
	}
	return fake
}

const nodeOk = () =>
	vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(
			async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { l1ChainId: 31337, rollupVersion: 1 } })),
		)

async function discovered(fakes: Fake[]) {
	nodeOk()
	const discover: Discover = () => ({
		wallets: (async function* () {
			for (const f of fakes) yield f.provider
		})(),
		cancel: () => {},
	})
	const connector = createRealConnector(TARGET, MANIFEST, discover)
	const options: WalletOption[] = []
	await connector.discover((o) => options.push(o), new AbortController().signal)
	return { connector, options }
}

const codeOf = (p: Promise<unknown>) =>
	p.then(
		() => "connected",
		(e: unknown) => (e instanceof ConnectError ? e.code : `other: ${String(e)}`),
	)

describe("the real connector", () => {
	test("drops a superseded run and undoes only its own channel", async () => {
		let release = () => {}
		const held = fakeProvider({ hold: new Promise<void>((r) => (release = () => r())) })
		const next = fakeProvider({})
		const { connector, options } = await discovered([held, next])
		const [heldOption, nextOption] = options as [WalletOption, WalletOption]
		const first = connector.connect(heldOption, async () => true)
		// Let the first run reach the wallet's confirm, past the emoji check, before the second starts.
		await new Promise((r) => setTimeout(r, 0))
		const second = await connector.connect(nextOption, async () => true)
		release()
		expect(await codeOf(first)).toBe("superseded")
		expect(held.cancels).toBe(0)
		expect(held.disconnects).toBe(1)
		expect(next.disconnects).toBe(0)
		expect(second.accounts).toEqual([ACCOUNT])
		expect(second.epoch).toBeGreaterThan(0)
	})

	test("maps a denied grant to words of its own, never the wallet's", async () => {
		const denied = fakeProvider({
			requestCapabilities: async () => {
				throw new Error("Capability denied by user <script>sentinel</script>")
			},
		})
		const rejected = fakeProvider({
			requestCapabilities: async () => Promise.reject(Object.assign(new Error("sentinel"), { code: 4001 })),
		})
		const { connector, options } = await discovered([denied, rejected])
		const errorOf = (o: WalletOption) =>
			connector
				.connect(o, async () => true)
				.then(
					() => {
						throw new Error("connected")
					},
					(e: unknown) => e as ConnectError,
				)
		const [d, r] = [await errorOf(options[0] as WalletOption), await errorOf(options[1] as WalletOption)]
		expect([d.code, r.code]).toEqual(["denied", "rejected"])
		expect(`${d.message}${r.message}`).not.toContain("sentinel")
		expect(denied.disconnects + rejected.disconnects).toBe(2)
	})

	test("keeps names and icons only in safe forms", async () => {
		const { options } = await discovered([
			fakeProvider({ name: "Good‮evil​ wallet", icon: PNG }),
			fakeProvider({ name: "​​", icon: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }),
			fakeProvider({ icon: "https://wallet.example/icon.png" }),
		])
		expect(options.map((o) => [o.name, o.icon])).toEqual([
			["Goodevil wallet", PNG],
			["Unnamed wallet", undefined],
			["Wallet", undefined],
		])
	})

	test("a remote disconnect supersedes the connection and tells the page once", async () => {
		const fake = fakeProvider({})
		const { connector, options } = await discovered([fake])
		const onDisconnect = vi.fn()
		connector.onDisconnect(onDisconnect)
		const connection = await connector.connect(options[0] as WalletOption, async () => true)
		expect(connection.grant.contracts).toEqual([at(0xa1), at(0xb2)])
		fake.drop()
		fake.drop()
		expect(onDisconnect).toHaveBeenCalledTimes(1)
		const again = await connector.connect(options[0] as WalletOption, async () => true)
		expect(again.epoch).toBeGreaterThan(connection.epoch + 1)
	})
})
