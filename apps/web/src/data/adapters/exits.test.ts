import { AztecAddress as SdkAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { ExecutionPayload } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import type { BridgeClient, ExitTicket as CoreExitTicket } from "@pp/bridge-core"
import type { Address, Hash, Hex, WalletClient } from "viem"
import { describe, expect, test, vi } from "vitest"
import type { StackManifestJson } from "../../build/target"
import { stageManifest } from "../capabilities"
import { bindAztecSend, bindL1Send, type SendContext } from "../sends"
import type { AztecAddress } from "../stack-types"
import type { HeldWallet } from "../wallet/connector"
import { parseGrant } from "../wallet/grant"
import type { AztecDeps } from "./aztec"
import { type ExitDeps, stackExits } from "./exits"
import { stackL1 } from "./l1"

const A32 = (n: string) => `0x${n.repeat(32)}` as AztecAddress
const [HUB, TOKEN, FPC, ME] = [A32("08"), A32("09"), A32("0c"), A32("1c")]
const PORTAL: Address = "0x0707070707070707070707070707070707070707"
const PAYEE: Address = "0x00000000000000000000000000000000000000d4"
const SENDER: Address = "0x00000000000000000000000000000000000000b2"
const DEPLOYMENT = `31337:${PORTAL}:${HUB}`
const L2_TX = A32("ab") as Hex
const L1_TX: Hash = `0x${"ef".repeat(32)}`
const ROLLUP = 5
const LABEL = 7n

const RAGEQUIT = {
	calls: [
		{ to: FPC, name: "sponsor_unconditionally" },
		{ to: HUB, name: "ragequit" },
	],
} as unknown as ExecutionPayload

const GRANT = parseGrant(stageManifest("2a", { hub: HUB, token: TOKEN, sponsoredFpc: FPC }), {
	granted: stageManifest("2a", { hub: HUB, token: TOKEN, sponsoredFpc: FPC }).capabilities.map((c) =>
		c.type === "accounts" ? { ...c, accounts: [{ alias: "a", item: ME }] } : c,
	),
})

const mined = { status: "proposed", isPending: () => false, isDropped: () => false, isMined: () => true, hasExecutionSucceeded: () => true }

function aztecWallet() {
	return {
		getAccounts: vi.fn(async () => [{ alias: "me", item: SdkAddress.fromStringUnsafe(ME) }]),
		getChainInfo: vi.fn(async () => ({ chainId: new Fr(31337n), version: new Fr(BigInt(ROLLUP)) })),
		registerContract: vi.fn(async () => {}),
		sendTx: vi.fn(async () => ({ txHash: { toString: () => A32("dd") } })),
	}
}

/** The exits adapter over fakes at the bridge client and the Aztec wallet, with the page's live context. */
function rig(notes: bigint[] = [40n], over: Partial<ExitDeps> = {}) {
	const wallet = aztecWallet()
	let held: HeldWallet | null = { epoch: 3, wallet: wallet as unknown as Wallet, grant: GRANT }
	const ctx: { -readonly [K in keyof SendContext]: SendContext[K] } = { account: SENDER, chainId: 31337, epoch: 3, aztecAccounts: [ME] }
	const aztec: AztecDeps = {
		deployment: { hub: HUB, token: TOKEN, chainId: 31337 },
		node: {
			getContract: vi.fn(async (a: unknown) => ({ address: a })),
			getTxReceipt: vi.fn(async () => mined),
			getNodeInfo: vi.fn(async () => ({ l1ChainId: 31337, rollupVersion: ROLLUP })),
		} as never,
		current: () => held,
	}
	const gate = { reached: () => {}, open: Promise.resolve(), release: () => {} }
	const client = {
		ragequitPayload: vi.fn(async (_a: unknown) => {
			gate.reached()
			await gate.open
			return RAGEQUIT
		}),
		exitTickets: vi.fn(async (_a: unknown): Promise<CoreExitTicket[]> => []),
		exitStatus: vi.fn(async (_t: CoreExitTicket) => "proving" as const),
		settle: vi.fn(async (_t: CoreExitTicket, _w: WalletClient): Promise<Hash> => L1_TX),
	}
	const readNotes = vi.fn(async (_owner: AztecAddress, _label: bigint) => notes)
	const exits = stackExits({
		manifest: {} as StackManifestJson,
		deployment: { id: DEPLOYMENT },
		aztec,
		notes: readNotes,
		l1: { settleWallet: vi.fn() } as unknown as ExitDeps["l1"],
		client: client as unknown as BridgeClient,
		...over,
	})
	const ragequit = (amount: bigint) =>
		exits.ragequit(
			ME,
			{ payee: PAYEE, label: LABEL, amount },
			bindAztecSend(() => ctx, ME),
		)
	return {
		exits,
		wallet,
		client,
		readNotes,
		ctx,
		ragequit,
		/** Replaces the live connection with a fresh wallet's, which must see no send either. */
		replace: () => {
			const next = aztecWallet()
			held = { epoch: 4, wallet: next as unknown as Wallet, grant: GRANT }
			return next
		},
		holdPayload: () => {
			let reach = () => {}
			const reached = new Promise<void>((r) => (reach = r))
			gate.reached = reach
			gate.open = new Promise<void>((r) => (gate.release = r))
			return reached
		},
		gate,
	}
}

describe("the exits adapter", () => {
	test("burns the one exact chunk the label's notes make at the send, and refuses an amount they no longer make in one call", async () => {
		const ok = rig([25n, 15n])
		await expect(ok.ragequit(40n)).resolves.toMatchObject({ status: "success" })
		expect(ok.readNotes).toHaveBeenCalledWith(ME, LABEL)
		expect(ok.client.ragequitPayload).toHaveBeenCalledWith({ payee: PAYEE, amount: 40n, label: LABEL })
		const [payload, opts] = ok.wallet.sendTx.mock.calls[0] as unknown as [ExecutionPayload, { from: { toString(): string } }]
		expect([payload, opts.from.toString()]).toEqual([RAGEQUIT, ME])

		// [30, 15] burns 30 or 45, never 40; nine notes of 5 burn 45 only in two calls.
		for (const [notes, amount] of [
			[[30n, 15n], 40n],
			[Array<bigint>(9).fill(5n), 45n],
		] as const) {
			const r = rig([...notes])
			await expect(r.ragequit(amount)).rejects.toMatchObject({ code: "NO_EXACT_CHUNKS" })
			expect(r.client.ragequitPayload).not.toHaveBeenCalled()
			expect(r.wallet.sendTx).not.toHaveBeenCalled()
		}
	})

	const CHANGES = {
		"connection replaced": (r: ReturnType<typeof rig>) => {
			r.ctx.epoch = 4
			return r.replace()
		},
		"connection replaced before the page hears of it": (r: ReturnType<typeof rig>) => r.replace(),
		"account left the page's connection": (r: ReturnType<typeof rig>) => {
			r.ctx.aztecAccounts = []
		},
		// The same channel, no disconnect: only the wallet's own answers show these.
		"account dropped by the wallet": (r: ReturnType<typeof rig>) => void r.wallet.getAccounts.mockResolvedValue([]),
		"wallet moved to another rollup": (r: ReturnType<typeof rig>) =>
			void r.wallet.getChainInfo.mockResolvedValue({ chainId: new Fr(31337n), version: new Fr(BigInt(ROLLUP + 1)) }),
	} as const

	test.each(Object.keys(CHANGES) as (keyof typeof CHANGES)[])(
		"a change while the ragequit is held (%s) reaches no sendTx",
		async (change) => {
			const r = rig()
			const reached = r.holdPayload()
			const run = r.ragequit(40n)
			await reached
			const next = CHANGES[change](r)
			r.gate.release()
			await expect(run).rejects.toMatchObject({ code: expect.stringMatching(/^(CONTEXT_CHANGED|RECIPIENT_NOT_IN_WALLET)$/) })
			expect(r.wallet.sendTx).not.toHaveBeenCalled()
			if (next) expect(next.sendTx).not.toHaveBeenCalled()
		},
	)

	test("lists one row per ticket, keyed by deployment, transaction and message index, each with its own status", async () => {
		const r = rig()
		const ticket = (i: number): CoreExitTicket => ({
			kind: "ragequit",
			token: TOKEN,
			payee: PAYEE,
			amount: 25n,
			label: LABEL,
			l2TxHash: L2_TX,
			messageIndexInTx: i,
		})
		r.client.exitTickets.mockResolvedValue([ticket(0), ticket(1)])
		r.client.exitStatus.mockImplementation(async (t) => (t.messageIndexInTx === 0 ? "settled" : "ready") as never)
		await expect(r.exits.tickets(PAYEE)).resolves.toEqual(
			(["settled", "ready"] as const).map((status, i) => ({
				key: { deployment: DEPLOYMENT, l2TxHash: L2_TX, messageIndexInTx: i },
				ticket: ticket(i),
				status,
			})),
		)
		expect(r.client.exitTickets).toHaveBeenCalledWith({ payee: PAYEE })
		r.client.exitTickets.mockResolvedValue([{ ...ticket(0), token: "0x01" }])
		await expect(r.exits.tickets(PAYEE)).rejects.toMatchObject({ code: "RPC_INCONSISTENT" })
	})

	test("settles from the sender through the injected wallet pinned to it and the target's chain; a refused handoff sends nothing", async () => {
		const asked: string[] = []
		const injected = {
			request: vi.fn(async ({ method }: { method: string }) => {
				asked.push(method)
				return L1_TX
			}),
		}
		const l1 = stackL1({ l1ChainId: 31337, l1RpcUrl: "http://127.0.0.1:8545" }, injected)
		const r = rig([40n], { l1 })
		r.client.settle.mockImplementation(async (_t, w) => {
			expect([w.account?.address, w.chain?.id]).toEqual([SENDER, 31337])
			return (await w.request({ method: "eth_sendTransaction", params: [{ from: SENDER, to: PORTAL }] })) as Hash
		})
		const t = { kind: "public", token: TOKEN, payee: PAYEE, amount: 25n, l2TxHash: L2_TX, messageIndexInTx: 0 } as const
		const live = () => r.ctx
		await expect(r.exits.settle(t, SENDER, bindL1Send(live, SENDER, 31337))).resolves.toBe(L1_TX)
		expect(asked).toEqual(["eth_sendTransaction"])

		r.ctx.account = "0x00000000000000000000000000000000000000c3"
		const moved = bindL1Send(live, SENDER, 31337)
		await expect(r.exits.settle(t, SENDER, moved)).rejects.toMatchObject({ code: 4001 })
		expect(asked).toEqual(["eth_sendTransaction"])
		expect(moved.refused()).toBe(true)
	})
})
