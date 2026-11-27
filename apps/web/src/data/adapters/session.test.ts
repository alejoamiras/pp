import { AztecAddress as SdkAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { ExecutionPayload } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import type { BridgeClient, BridgeReceipt, BridgeSession, openBridgeSession, PreparedBridgeSpend } from "@pp/bridge-core"
import { tokenBridgeHubArtifact } from "@pp/bridge-core/artifacts"
import { secretDerivationTypedData } from "@pp/pool-client"
import { type Address, type Hash, type Hex, TransactionNotFoundError, TransactionReceiptNotFoundError } from "viem"
import { describe, expect, test, vi } from "vitest"
import type { StackManifestJson } from "../../build/target"
import { virtualTimer } from "../../test-utils/timer"
import { createBridgeDriver, createOutstanding, type LiveContext } from "../bridge-driver"
import { stageManifest } from "../capabilities"
import { isUserRejection } from "../errors"
import type { Attempt, Proved, SubmitHooks } from "../ports"
import type { AztecAddress, BridgeRecordView } from "../stack-types"
import { readPool } from "../reconcile"
import type { HeldWallet } from "../wallet/connector"
import { parseGrant } from "../wallet/grant"
import type { AztecDeps } from "./aztec"
import type { DelegatingProver } from "./prover"
import { JOURNAL_PREFIX, journalStore, l1TxState, type PageStorage, type SessionDeps, stackSessions } from "./session"

const A20 = (n: string) => `0x${n.repeat(20)}`
const A32 = (n: string) => `0x${n.repeat(32)}`
const OWNER: Address = "0x00000000000000000000000000000000000000a1"
const SENDER: Address = "0x00000000000000000000000000000000000000b2"
const SIGNATURE: Hex = `0x${"5a".repeat(65)}`
const TX: Hash = `0x${"ab".repeat(32)}`
const RECIPIENT = A32("1c") as AztecAddress
const HUB = A32("08") as AztecAddress
const TOKEN = A32("09") as AztecAddress
const FPC = A32("0c") as AztecAddress
const ROLLUP = 5
const chainInfo = (version = ROLLUP) => ({ chainId: new Fr(31337n), version: new Fr(BigInt(version)) })

const MANIFEST: StackManifestJson = {
	version: 1,
	chainId: 31337,
	l1Rpc: "http://127.0.0.1:8545",
	aztecNode: "http://127.0.0.1:8080",
	pool: {
		poolVault: A20("01"),
		entrypoint: A20("02"),
		aspRegistry: A20("03"),
		keystore: A20("04"),
		asset: A20("05"),
		deployBlock: "12",
		aspApiUrl: "http://127.0.0.1:8600",
	},
	bridge: { factory: A20("06"), portal: A20("07"), hub: HUB, token: TOKEN, registry: A32("0a"), deployBlock: "34" },
}
const DEPLOYMENT_ID = `31337:${A20("07")}:${HUB}`

const RECEIPT: BridgeReceipt = {
	l1TxHash: TX,
	portal: A20("07") as Address,
	messageKey: A32("33") as Hex,
	leafIndex: 4n,
	nullifier: 9n,
	changeCommitment: 11n,
	amount: 70n,
	asset: A20("05") as Address,
}

const missingReceipt = () => Promise.reject(new TransactionReceiptNotFoundError({ hash: TX }))
const missingTx = () => Promise.reject(new TransactionNotFoundError({ hash: TX }))

/** The 2a grant as a wallet that echoes the request answers it. */
const GRANT = parseGrant(stageManifest("2a", { hub: HUB, token: TOKEN, sponsoredFpc: FPC }), {
	granted: stageManifest("2a", { hub: HUB, token: TOKEN, sponsoredFpc: FPC }).capabilities.map((c) =>
		c.type === "accounts" ? { ...c, accounts: [{ alias: "a", item: RECIPIENT }] } : c,
	),
})

const CLAIM: ExecutionPayload = {
	calls: [
		{ to: FPC, name: "sponsor_unconditionally" },
		{ to: HUB, name: "claim_from_pool" },
	],
} as unknown as ExecutionPayload

function attempt(seq: number): Attempt {
	return Object.freeze({
		seq,
		owner: OWNER,
		sender: SENDER,
		demo: false,
		recipient: RECIPIENT,
		deployment: DEPLOYMENT_ID,
		chainId: 31337,
		epoch: 1,
		note: 7n,
		amount: 70n,
	})
}

const minedReceipt = {
	status: "proposed",
	isPending: () => false,
	isDropped: () => false,
	isMined: () => true,
	hasExecutionSucceeded: () => true,
}

/** A fresh Aztec wallet that records what it is asked. */
function freshWallet() {
	const calls: string[] = []
	const wallet = {
		getChainInfo: vi.fn(async () => {
			calls.push("getChainInfo")
			return chainInfo()
		}),
		getAccounts: vi.fn(async () => {
			calls.push("getAccounts")
			return [{ alias: "a", item: SdkAddress.fromStringUnsafe(RECIPIENT) }]
		}),
		simulateTx: vi.fn(async () => calls.push("simulateTx")),
		registerContract: vi.fn(async () => void calls.push("registerContract")),
		sendTx: vi.fn(async () => {
			calls.push("sendTx")
			return { txHash: { toString: () => A32("dd") } }
		}),
	}
	return { wallet, calls, asWallet: wallet as unknown as Wallet }
}

function memoryStorage(seed: Record<string, string> = {}): PageStorage & { data: Map<string, string> } {
	const data = new Map(Object.entries(seed))
	return {
		data,
		getItem: (k) => data.get(k) ?? null,
		setItem: (k, v) => void data.set(k, v),
		removeItem: (k) => void data.delete(k),
		key: (i) => [...data.keys()][i] ?? null,
		get length() {
			return data.size
		},
	}
}

/** A stack session over fakes at the bridge client, the Ethereum client and the Aztec wallet. */
function rig(o: Partial<Pick<SessionDeps, "open" | "reads">> = {}) {
	const aztecWallet = freshWallet()
	let held: HeldWallet | null = { epoch: 1, wallet: aztecWallet.asWallet, grant: GRANT }
	const gate: { reached: () => void; open: Promise<void>; release: () => void } = {
		reached: () => {},
		open: Promise.resolve(),
		release: () => {},
	}
	const client = {
		preflight: vi.fn(async () => {}),
		submit: vi.fn(async () => RECEIPT),
		waitClaimable: vi.fn(async () => {}),
		claimPayload: vi.fn(async () => {
			gate.reached()
			await gate.open
			return CLAIM
		}),
		recover: vi.fn(async () => [{ ...RECEIPT, id: "r1" }]),
		records: vi.fn(async () => [
			{ id: "r1", nullifier: 9n, recipient: { toString: () => RECIPIENT }, amount: 70n, step: "mined", receipt: RECEIPT },
		]),
	} as unknown as BridgeClient & Record<keyof BridgeClient, ReturnType<typeof vi.fn>>
	const spendWallet = vi.fn(() => ({ marker: "pinned client" }))
	const aztec: AztecDeps = {
		deployment: { hub: HUB, token: TOKEN },
		node: {
			getContract: vi.fn(async (a) => ({ address: a })),
			getTxReceipt: vi.fn(async () => minedReceipt),
			getNodeInfo: vi.fn(async () => ({ l1ChainId: 31337, rollupVersion: ROLLUP })),
		} as never,
		current: () => held,
	}
	const spend = { amount: 70n, change: { label: 3n, value: 30n } } as unknown as PreparedBridgeSpend
	const prepare = vi.fn(async () => spend)
	const storage = memoryStorage({ other: "kept" })
	const deps: SessionDeps = {
		manifest: MANIFEST,
		reads: { getTransaction: missingTx, getTransactionReceipt: missingReceipt } as unknown as SessionDeps["reads"],
		prover: { cancel: vi.fn() } as unknown as DelegatingProver,
		artifacts: { kind: "gateway", urls: ["http://127.0.0.1:5173"] },
		l1: { spendWallet } as unknown as SessionDeps["l1"],
		aztec,
		storage,
		open: (async () => ({ l1Address: OWNER, pool: { notes: async () => [] } })) as unknown as typeof openBridgeSession,
		prepare: prepare as unknown as SessionDeps["prepare"],
		client,
		...o,
	}
	return {
		client,
		spend,
		spendWallet,
		prepare,
		aztecWallet,
		storage,
		open: () => stackSessions(deps).open({ owner: OWNER, sign: async () => SIGNATURE }),
		sessions: () => stackSessions(deps),
		replaceConnection: (next: HeldWallet | null) => {
			held = next
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

const hooks = (): SubmitHooks & { reproved: string[] } => {
	const reproved: string[] = []
	return { reproved, reproving: (c) => reproved.push(c), handoff: () => {}, sent: () => {} }
}

describe("the stack session", () => {
	test("signs the derivation request, opens the bridge session with the page's prover and own origin, and reads notes through it", async () => {
		const prover = { cancel: vi.fn() } as unknown as DelegatingProver
		const artifacts: SessionDeps["artifacts"] = { kind: "gateway", urls: ["http://127.0.0.1:5173"] }
		const notes = [{ commitment: 1n }]
		const open = vi.fn(async () => ({ l1Address: OWNER, pool: { notes: async () => notes } }) as unknown as BridgeSession)
		const sign = vi.fn(async () => SIGNATURE)
		const r = rig()
		const sessions = stackSessions({
			manifest: MANIFEST,
			reads: {} as SessionDeps["reads"],
			prover,
			artifacts,
			l1: {} as SessionDeps["l1"],
			aztec: {} as AztecDeps,
			storage: r.storage,
			open: open as typeof openBridgeSession,
			client: r.client,
		})

		const session = await sessions.open({ owner: OWNER, sign })
		expect(sign).toHaveBeenCalledWith(secretDerivationTypedData(OWNER))
		expect(open).toHaveBeenCalledWith(
			expect.objectContaining({
				l1Address: OWNER,
				signature: SIGNATURE,
				artifacts,
				prover,
				manifest: expect.objectContaining({ chainId: 31337 }),
			}),
		)
		await expect(session.notes()).resolves.toBe(notes)
		session.cancelProve()
		expect(prover.cancel).toHaveBeenCalledOnce()
	})

	test("a hash is mined or reverted by its receipt, pending with only a transaction, unknown with neither; an RPC failure is no answer", async () => {
		const found = () => Promise.resolve({})
		const state = (getTransactionReceipt: () => Promise<unknown>, getTransaction: () => Promise<unknown>) =>
			l1TxState({ getTransactionReceipt, getTransaction } as unknown as SessionDeps["reads"], TX)
		await expect(state(async () => ({ status: "success" }), missingTx)).resolves.toBe("mined")
		await expect(state(async () => ({ status: "reverted" }), found)).resolves.toBe("reverted")
		await expect(state(missingReceipt, found)).resolves.toBe("pending")
		await expect(state(missingReceipt, missingTx)).resolves.toBe("unknown")
		await expect(state(() => Promise.reject(new Error("fetch failed")), found)).rejects.toThrow("fetch failed")
	})

	test("a reverted retry beside an earlier attempt still out is unconfirmed after a reload, never a bridge", async () => {
		const note = { commitment: 7n, label: 3n, value: 100n, asset: A20("05"), status: "approved" }
		const r = rig({
			open: (async () => ({
				l1Address: OWNER,
				pool: { notes: async () => [note], nullifierOf: async () => 9n },
			})) as unknown as typeof openBridgeSession,
			reads: {
				getTransactionReceipt: async () => ({ status: "reverted" }),
				getTransaction: async () => ({}),
			} as unknown as SessionDeps["reads"],
		})
		// bridge-core's view of it: no event, so no receipt, and the latest attempt's hash.
		r.client.records.mockResolvedValue([
			{ id: "r1", nullifier: 9n, recipient: { toString: () => RECIPIENT }, amount: 70n, l1TxHash: TX, step: "submitted" },
		])
		r.client.recover.mockResolvedValue([])
		const pool = await readPool(await r.open(), [RECIPIENT])
		expect(pool.bridges).toEqual([])
		expect([...pool.uncertain.keys()]).toEqual([7n])
	})

	test("a proof made under one attempt is refused under another before the bridge client sees it, and spends once", async () => {
		const r = rig()
		const session = await r.open()
		const a = attempt(1)
		const proved = await session.prove(a)
		expect(proved).toMatchObject({ note: 7n, label: 3n, amount: 70n, change: 30n })
		await expect(session.submit(proved, attempt(2), hooks())).rejects.toMatchObject({ code: "SPEND_MISMATCH" })
		await expect(session.submit(proved, a, hooks())).rejects.toMatchObject({ code: "SPEND_MISMATCH" })
		await expect(session.submit({ ...proved } as Proved, a, hooks())).rejects.toMatchObject({ code: "SPEND_MISMATCH" })
		expect(r.client.submit).not.toHaveBeenCalled()
		expect(r.spendWallet).not.toHaveBeenCalled()

		const again = await session.prove(a)
		const record = await session.submit(again, a, hooks())
		expect(r.client.submit).toHaveBeenCalledOnce()
		expect(r.client.submit.mock.calls[0]?.[0]).toBe(r.spend)
		expect(record).toMatchObject({ id: "r1", recipient: RECIPIENT, step: "mined" })
	})

	test("a spend goes through the client pinned to its attempt, shows each re-proof, and takes the override only when asked", async () => {
		const r = rig()
		const session = await r.open()
		const a = attempt(1)
		const on = hooks()
		r.client.submit.mockImplementationOnce(async (_s: unknown, _w: unknown, _b: unknown, o: { onReprove: (c: string) => void }) => {
			o.onReprove("ASP_ROOT_STALE")
			return RECEIPT
		})
		await session.submit(await session.prove(a), a, on)
		expect(r.spendWallet).toHaveBeenCalledWith(a, on.handoff, on)
		expect(r.client.submit.mock.calls[0]?.[1]).toEqual({ marker: "pinned client" })
		expect(r.client.submit.mock.calls[0]?.[3]).not.toHaveProperty("acceptUncertain")
		expect(on.reproved).toEqual(["ASP_ROOT_STALE"])

		await session.submit(await session.prove(a), a, hooks(), { acceptUncertain: true })
		expect(r.client.submit.mock.calls[1]?.[3]).toMatchObject({ acceptUncertain: true })

		const { BridgeClientError } = await import("@pp/bridge-core")
		r.client.submit.mockRejectedValueOnce(new BridgeClientError("RPC_FAILED", { source: "UserRejectedRequestError" }))
		const declined = await session.submit(await session.prove(a), a, hooks()).catch((e: unknown) => e)
		expect(isUserRejection(declined)).toBe(true)
	})

	test("preflight hands the bridge client only the live connection's three calls, and simulations the grant allows", async () => {
		const r = rig()
		const session = await r.open()
		await session.preflight(RECIPIENT, 1)
		const { wallet } = r.client.preflight.mock.calls[0]![0] as {
			recipient: { toString(): string }
			wallet: Record<string, (...a: unknown[]) => Promise<unknown>>
		}
		expect(Object.keys(wallet).sort()).toEqual(["getAccounts", "getChainInfo", "simulateTx"])
		await wallet.getChainInfo?.()
		await wallet.getAccounts?.()
		await wallet.simulateTx?.({ calls: [{ to: FPC, name: "sponsor_unconditionally" }] }, { from: RECIPIENT })
		await expect(wallet.simulateTx?.({ calls: [{ to: TOKEN, name: "transfer_public" }] }, { from: RECIPIENT })).rejects.toMatchObject({
			code: "NOT_GRANTED",
		})
		expect(r.aztecWallet.calls).toEqual(["getChainInfo", "getAccounts", "simulateTx"])

		r.replaceConnection({ epoch: 2, wallet: freshWallet().asWallet, grant: GRANT })
		await expect(wallet.getAccounts?.()).rejects.toMatchObject({ code: "CONTEXT_CHANGED" })
		expect(r.aztecWallet.calls).toHaveLength(3)
	})

	test("records and recover carry the recipient as the app's hex, and a claim waits on and sends the record they named", async () => {
		const r = rig()
		const session = await r.open()
		const [recovered] = await session.recover(RECIPIENT)
		expect(recovered).toMatchObject({ id: "r1", recipient: RECIPIENT, step: "mined", l1TxHash: TX })
		const [listed] = await session.records()
		expect(listed?.recipient).toBe(RECIPIENT)
		const signal = new AbortController().signal
		await session.waitClaimable("r1", signal)
		expect(r.client.waitClaimable).toHaveBeenCalledWith(RECEIPT, { signal })
		await expect(session.waitClaimable("unknown", signal)).rejects.toMatchObject({ code: "NOT_CLAIMABLE" })
	})

	test("the journal keeps to the app's prefix, and forgetting deletes only it", async () => {
		const r = rig()
		journalStore(r.storage).setItem("pp.bridge.j1.x", "sealed")
		expect([...r.storage.data.keys()]).toEqual(["other", `${JOURNAL_PREFIX}pp.bridge.j1.x`])
		await r.sessions().forget()
		expect([...r.storage.data.keys()]).toEqual(["other"])
	})
})

describe("a claim's handoff", () => {
	const RECORD: BridgeRecordView = { id: "r1", nullifier: 9n, recipient: RECIPIENT, amount: 70n, step: "claimable" }

	async function claimRig() {
		const r = rig()
		const session = await r.open()
		await session.recover(RECIPIENT)
		const ctx: { -readonly [K in keyof LiveContext]: LiveContext[K] } = {
			owner: OWNER,
			account: SENDER,
			selected: SENDER,
			demo: false,
			chainId: 31337,
			deployment: DEPLOYMENT_ID,
			epoch: 1,
			aztecAccounts: [RECIPIENT],
		}
		let granted = true
		const events: string[] = []
		const driver = createBridgeDriver({
			outstanding: createOutstanding(),
			session,
			deployment: { id: DEPLOYMENT_ID, chainId: 31337 },
			timer: virtualTimer(),
			frame: async () => {},
			context: () => ({ ...ctx }),
			canClaim: () => granted,
		})
		const claim = () => driver.claim(RECORD, (e) => events.push(e.type), new AbortController().signal)
		return { ...r, ctx, events, claim, revoke: () => (granted = false) }
	}

	test("sends from the recipient, paid inside the payload, after teaching a fresh wallet the hub and the token", async () => {
		const c = await claimRig()
		await c.claim()
		expect(c.aztecWallet.wallet.sendTx).toHaveBeenCalledOnce()
		const [payload, opts] = c.aztecWallet.wallet.sendTx.mock.calls[0] as unknown as [
			ExecutionPayload,
			{ from: { toString(): string }; wait: unknown },
		]
		expect(payload).toBe(CLAIM)
		expect([opts.from.toString(), opts.wait]).toEqual([RECIPIENT, "NO_WAIT"])
		const taught = c.aztecWallet.wallet.registerContract.mock.calls as unknown as [{ address: { toString(): string } }, unknown][]
		expect(taught.map(([i]) => i.address.toString())).toEqual([HUB, TOKEN])
		expect(taught[0]?.[1]).toBe(tokenBridgeHubArtifact)
		expect(c.events.at(-1)).toBe("claimed")
	})

	const CHANGES = {
		account: (c: Awaited<ReturnType<typeof claimRig>>) =>
			Object.assign(c.ctx, {
				account: "0x00000000000000000000000000000000000000c3",
				selected: "0x00000000000000000000000000000000000000c3",
			}),
		chain: (c: Awaited<ReturnType<typeof claimRig>>) => Object.assign(c.ctx, { chainId: 1 }),
		epoch: (c: Awaited<ReturnType<typeof claimRig>>) => {
			c.ctx.epoch = 2
			c.replaceConnection({ epoch: 2, wallet: freshWallet().asWallet, grant: GRANT })
		},
		grant: (c: Awaited<ReturnType<typeof claimRig>>) => c.revoke(),
		"connection replaced before the page hears of it": (c: Awaited<ReturnType<typeof claimRig>>) =>
			c.replaceConnection({ epoch: 2, wallet: freshWallet().asWallet, grant: GRANT }),
		// The same channel, no disconnect: only the wallet's own answers show these.
		"recipient dropped by the wallet": (c: Awaited<ReturnType<typeof claimRig>>) =>
			c.aztecWallet.wallet.getAccounts.mockResolvedValue([]),
		"wallet moved to another rollup": (c: Awaited<ReturnType<typeof claimRig>>) =>
			c.aztecWallet.wallet.getChainInfo.mockResolvedValue(chainInfo(ROLLUP + 1)),
	} as const

	test.each(Object.keys(CHANGES) as (keyof typeof CHANGES)[])(
		"a change while the claim is held (%s) reaches no sendTx",
		async (change) => {
			const c = await claimRig()
			const reached = c.holdPayload()
			const run = c.claim()
			await reached
			CHANGES[change](c)
			c.gate.release()
			await run
			expect(c.aztecWallet.wallet.sendTx).not.toHaveBeenCalled()
			expect(c.events.at(-1)).toBe("failed")
		},
	)
})
