import { AztecAddress as SdkAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { ExecutionPayload } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { describe, expect, test, vi } from "vitest"
import { stageManifest } from "../capabilities"
import type { AllowListPort, AztecSendHooks, Stage } from "../ports"
import type { AztecAddress, LabelCheck } from "../stack-types"
import type { HeldWallet } from "../wallet/connector"
import { parseGrant } from "../wallet/grant"
import type { AztecDeps } from "./aztec"
import { stackTokenSends } from "./token-sends"

const at = (n: string) => `0x${n.repeat(32)}` as AztecAddress
const [HUB, TOKEN, FPC, ME, YOU] = [at("08"), at("09"), at("0c"), at("1c"), at("2d")]
const T = { hub: HUB, token: TOKEN, sponsoredFpc: FPC }
/** A label holding more than any test spends, in one note. */
const ENOUGH = async () => [1000n]
/** The whole request granted, as an honest wallet answers it. */
function grantAt(stage: Stage) {
	const manifest = stageManifest(stage, T)
	return parseGrant(manifest, {
		granted: manifest.capabilities.map((c) => (c.type === "accounts" ? { ...c, accounts: [{ item: ME }] } : c)),
	})
}
/** More public balance than any test shields. */
const PUBLIC = async () => 1000n
const ACTIVE: LabelCheck = { state: "ACTIVE", path: { index: 1, depth: 1, siblings: [7n, ...Array(17).fill(0n)] } }

/** A connected wallet whose answers a test can change while the send waits on the allow list. */
function rig(stage: Stage = "2b") {
	const wallet = {
		getAccounts: vi.fn(async () => [{ alias: "me", item: SdkAddress.fromStringUnsafe(ME) }]),
		getChainInfo: vi.fn(async () => ({ chainId: new Fr(31337n), version: new Fr(5n) })),
		registerContract: vi.fn(async () => {}),
		sendTx: vi.fn(async (_p: ExecutionPayload) => ({ txHash: { toString: () => at("dd") } })),
	}
	let live: HeldWallet | null = { epoch: 3, wallet: wallet as unknown as Wallet, grant: grantAt(stage) }
	const node = {
		getContract: vi.fn(async (a: { toString(): string }) => ({ address: a })),
		getTxReceipt: vi.fn(async () => ({
			status: "proposed",
			isPending: () => false,
			isDropped: () => false,
			isMined: () => true,
			hasExecutionSucceeded: () => true,
		})),
		getNodeInfo: vi.fn(async () => ({ l1ChainId: 31337, rollupVersion: 5 })),
	}
	const aztec: AztecDeps = { deployment: { hub: HUB, token: TOKEN, chainId: 31337 }, node: node as never, current: () => live }
	let release: (c: LabelCheck) => void = () => {}
	const checked = new Promise<LabelCheck>((r) => {
		release = r
	})
	const allowList: Pick<AllowListPort, "current" | "check"> = {
		current: async () => ({
			record: { sequence: 1n, poolRoot: 9n, birthRoot: 0n, l1Block: 1n, rootTime: 1n, poolSize: 1n, birthSize: 0n },
			nowSec: 2n,
		}),
		check: () => checked,
	}
	const sends = stackTokenSends({ aztec, allowList, sponsoredFpc: FPC, notes: ENOUGH, publicBalance: PUBLIC })
	return {
		wallet,
		aztec,
		sends,
		release: (c: LabelCheck = ACTIVE) => release(c),
		reconnect: () => {
			live = live && { ...live, epoch: live.epoch + 1 }
		},
	}
}

const on = (handoff = () => {}): AztecSendHooks => ({ epoch: 3, handoff })
const transfer = (r: ReturnType<typeof rig>, hooks = on()) =>
	r.sends.transferPrivate(ME, { to: YOU, amount: 5n, label: 77n, origin: 0 }, hooks)
const unshield = (r: ReturnType<typeof rig>, hooks = on()) => r.sends.unshield(ME, { amount: 5n, label: 77n, origin: 0 }, hooks)
const settle = () => new Promise((r) => setTimeout(r, 0))

describe("the token's checked spends", () => {
	test("a change of account, chain or epoch while the send is held sends nothing through the wallet", async () => {
		const changes: [string, (r: ReturnType<typeof rig>) => void, string][] = [
			["the connection is replaced", (r) => r.reconnect(), "CONTEXT_CHANGED"],
			["the wallet drops the account", (r) => r.wallet.getAccounts.mockResolvedValue([]), "RECIPIENT_NOT_IN_WALLET"],
			[
				"the wallet moves to another rollup",
				(r) => r.wallet.getChainInfo.mockResolvedValue({ chainId: new Fr(31337n), version: new Fr(6n) }),
				"CONTEXT_CHANGED",
			],
		]
		for (const send of [transfer, unshield])
			for (const [what, change, code] of changes) {
				const r = rig()
				const sent = send(r)
				await settle()
				change(r)
				r.release()
				await expect(sent, what).rejects.toMatchObject({ code })
				expect(r.wallet.sendTx, what).not.toHaveBeenCalled()
			}
		const r = rig()
		const handoff = vi.fn(() => {
			throw new Error("the page's account changed")
		})
		const sent = unshield(r, on(handoff))
		r.release()
		await expect(sent).rejects.toThrow("the page's account changed")
		expect(handoff).toHaveBeenCalledOnce()
		expect(r.wallet.sendTx).not.toHaveBeenCalled()
	})

	test("checks the label again against the record that is latest after the first check, and sends nothing if it left", async () => {
		const r = rig()
		const first = {
			record: { sequence: 1n, poolRoot: 9n, birthRoot: 0n, l1Block: 1n, rootTime: 1n, poolSize: 1n, birthSize: 0n },
			nowSec: 2n,
		}
		const later = { ...first, record: { ...first.record, sequence: 2n, poolRoot: 10n } }
		const current = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(later)
		const check = vi.fn().mockResolvedValueOnce(ACTIVE).mockResolvedValueOnce({ state: "ABSENT" })
		const sends = stackTokenSends({
			aztec: r.aztec,
			allowList: { current, check },
			sponsoredFpc: FPC,
			notes: ENOUGH,
			publicBalance: PUBLIC,
		})
		await expect(sends.unshield(ME, { amount: 5n, label: 77n, origin: 0 }, on())).rejects.toMatchObject({ code: "LABEL_ABSENT" })
		expect(check.mock.calls.map(([view]) => view)).toEqual([first, later])
		expect(r.wallet.sendTx).not.toHaveBeenCalled()
	})

	test("takes a path only once the record read after its check has the same roots, and refuses a list that keeps moving", async () => {
		const r = rig()
		const view = (sequence: bigint, poolRoot: bigint) => ({
			record: { sequence, poolRoot, birthRoot: 0n, l1Block: 1n, rootTime: sequence, poolSize: 1n, birthSize: 0n },
			nowSec: 2n,
		})
		const settled = vi.fn().mockResolvedValueOnce(view(1n, 9n)).mockResolvedValue(view(2n, 9n))
		const check = vi.fn().mockResolvedValue(ACTIVE)
		const sends = stackTokenSends({
			aztec: r.aztec,
			allowList: { current: settled, check },
			sponsoredFpc: FPC,
			notes: ENOUGH,
			publicBalance: PUBLIC,
		})
		await sends.unshield(ME, { amount: 5n, label: 77n, origin: 0 }, on())
		expect([check.mock.calls.length, settled.mock.calls.length]).toEqual([1, 2])
		let root = 20n
		const moving = vi.fn(async () => view(root, root++))
		check.mockClear()
		const again = stackTokenSends({
			aztec: r.aztec,
			allowList: { current: moving, check },
			sponsoredFpc: FPC,
			notes: ENOUGH,
			publicBalance: PUBLIC,
		})
		await expect(again.unshield(ME, { amount: 5n, label: 77n, origin: 0 }, on())).rejects.toMatchObject({ code: "LIST_STALE" })
		expect(check).toHaveBeenCalledTimes(3)
		expect(r.wallet.sendTx).toHaveBeenCalledTimes(1)
	})

	test("checks again when the record read after its check keeps the roots but commits to another list length", async () => {
		const r = rig()
		const view = (sequence: bigint, poolSize: bigint) => ({
			record: { sequence, poolRoot: 9n, birthRoot: 0n, l1Block: 1n, rootTime: sequence, poolSize, birthSize: 0n },
			nowSec: 2n,
		})
		const current = vi.fn().mockResolvedValueOnce(view(1n, 1n)).mockResolvedValue(view(2n, 2n))
		const check = vi.fn().mockResolvedValue(ACTIVE)
		const sends = stackTokenSends({
			aztec: r.aztec,
			allowList: { current, check },
			sponsoredFpc: FPC,
			notes: ENOUGH,
			publicBalance: PUBLIC,
		})
		await sends.unshield(ME, { amount: 5n, label: 77n, origin: 0 }, on())
		expect(check.mock.calls.map(([v]) => v.record.poolSize)).toEqual([1n, 2n])
	})

	test("refuses as stale, checking nothing, a record that carries no list", async () => {
		const r = rig()
		const cleared = { sequence: 9n, poolRoot: 0n, birthRoot: 0n, l1Block: 0n, rootTime: 0n, poolSize: 0n, birthSize: 0n }
		const check = vi.fn().mockResolvedValue(ACTIVE)
		const sends = stackTokenSends({
			aztec: r.aztec,
			allowList: { current: async () => ({ record: cleared, nowSec: 2n }), check },
			sponsoredFpc: FPC,
			notes: ENOUGH,
			publicBalance: PUBLIC,
		})
		await expect(sends.unshield(ME, { amount: 5n, label: 77n, origin: 0 }, on())).rejects.toMatchObject({ code: "LIST_STALE" })
		expect([check.mock.calls.length, r.wallet.sendTx.mock.calls.length]).toEqual([0, 0])
	})

	test("refuses a path whose roots held through the check but aged past spending by the read after it", async () => {
		const r = rig()
		// For rootTime 1, 1501 is the last read time still fresh once the proving budget is added.
		const read = (nowSec: bigint) => ({
			record: { sequence: 1n, poolRoot: 9n, birthRoot: 0n, l1Block: 1n, rootTime: 1n, poolSize: 1n, birthSize: 0n },
			nowSec,
		})
		const check = vi.fn().mockResolvedValue(ACTIVE)
		const through = (later: bigint) =>
			stackTokenSends({
				aztec: r.aztec,
				allowList: { current: vi.fn().mockResolvedValueOnce(read(2n)).mockResolvedValueOnce(read(later)), check },
				sponsoredFpc: FPC,
				notes: ENOUGH,
				publicBalance: PUBLIC,
			}).unshield(ME, { amount: 5n, label: 77n, origin: 0 }, on())
		await through(1501n)
		await expect(through(1502n)).rejects.toMatchObject({ code: "LIST_STALE" })
		expect(r.wallet.sendTx).toHaveBeenCalledTimes(1)
	})

	test("reads the label's notes after the list check and refuses before the handoff what one transaction cannot spend", async () => {
		const r = rig()
		const order: string[] = []
		const handoff = vi.fn()
		const sends = stackTokenSends({
			aztec: r.aztec,
			allowList: {
				current: async () => ({
					record: { sequence: 1n, poolRoot: 9n, birthRoot: 0n, l1Block: 1n, rootTime: 1n, poolSize: 1n, birthSize: 0n },
					nowSec: 2n,
				}),
				check: async () => {
					order.push("check")
					return ACTIVE
				},
			},
			sponsoredFpc: FPC,
			notes: async () => {
				order.push("notes")
				return [5n, 5n]
			},
			publicBalance: PUBLIC,
		})
		await expect(sends.unshield(ME, { amount: 11n, label: 77n, origin: 0 }, on(handoff))).rejects.toMatchObject({
			code: "OVER_NOTE_CAP",
		})
		expect(order).toEqual(["check", "notes"])
		expect(handoff).not.toHaveBeenCalled()
		expect(r.wallet.sendTx).not.toHaveBeenCalled()
	})

	test("sends the label's checked path, paid by the SponsoredFPC, and refuses a label the list does not hold", async () => {
		const r = rig()
		const sent = unshield(r)
		r.release()
		await expect(sent).resolves.toMatchObject({ status: "success" })
		const payload = r.wallet.sendTx.mock.calls[0]?.[0] as ExecutionPayload
		expect(payload.calls.map((c) => [c.to.toString(), c.name])).toEqual([
			[FPC, "sponsor_unconditionally"],
			[TOKEN, "unshield"],
		])
		const args = payload.calls[1]?.args.map((a) => a.toBigInt())
		expect(args?.slice(0, 5)).toEqual([5n, 77n, 1n, 1n, 7n])
		for (const [check, code] of [
			[{ state: "ABSENT" }, "LABEL_ABSENT"],
			[{ state: "STALE_ROOT", reason: "age" }, "LIST_STALE"],
		] as const) {
			const q = rig()
			const refused = transfer(q)
			q.release(check)
			await expect(refused).rejects.toMatchObject({ code })
			expect(q.wallet.sendTx).not.toHaveBeenCalled()
		}
	})
})

describe("the shield", () => {
	test("sends shield(amount) paid by the SponsoredFPC with no label path, handing off right before the wallet sends", async () => {
		const unchecked = () => ({ current: vi.fn(), check: vi.fn() })
		const shield = (
			r: ReturnType<typeof rig>,
			allowList: ReturnType<typeof unchecked>,
			hooks: AztecSendHooks,
			publicBalance = PUBLIC,
		) => stackTokenSends({ aztec: r.aztec, allowList, sponsoredFpc: FPC, notes: ENOUGH, publicBalance }).shield(ME, 5n, hooks)

		const r = rig("2c")
		const list = unchecked()
		const order: string[] = []
		r.wallet.sendTx.mockImplementation(async () => {
			order.push("send")
			return { txHash: { toString: () => at("dd") } }
		})
		await expect(
			shield(
				r,
				list,
				on(() => void order.push("handoff")),
			),
		).resolves.toMatchObject({ status: "success" })
		expect(order).toEqual(["handoff", "send"])
		const payload = r.wallet.sendTx.mock.calls[0]?.[0] as ExecutionPayload
		expect(payload.calls.map((c) => [c.to.toString(), c.name])).toEqual([
			[FPC, "sponsor_unconditionally"],
			[TOKEN, "shield"],
		])
		expect(payload.calls[1]?.args.map((a) => a.toBigInt())).toEqual([5n])
		expect(payload.feePayer?.toString()).toBe(FPC)
		expect([list.current, list.check].map((f) => f.mock.calls.length)).toEqual([0, 0])

		const refused = rig("2c")
		const handoff = () => {
			throw new Error("the page's account changed")
		}
		await expect(shield(refused, unchecked(), on(handoff))).rejects.toThrow("the page's account changed")
		expect(refused.wallet.sendTx).not.toHaveBeenCalled()
		const ungranted = rig("2b")
		await expect(shield(ungranted, unchecked(), on())).rejects.toMatchObject({ code: "NOT_GRANTED" })
		expect(ungranted.wallet.sendTx).not.toHaveBeenCalled()

		// The balance is read again at the send, so one spent since the dialog opened is refused before the handoff.
		const spent = rig("2c")
		const neverHanded = vi.fn()
		const balance = vi.fn(async () => 4n)
		await expect(shield(spent, unchecked(), on(neverHanded), balance)).rejects.toMatchObject({ code: "OVER_PUBLIC_BALANCE" })
		expect(balance).toHaveBeenCalledWith(ME)
		expect(neverHanded).not.toHaveBeenCalled()
		expect(spent.wallet.sendTx).not.toHaveBeenCalled()
	})
})
