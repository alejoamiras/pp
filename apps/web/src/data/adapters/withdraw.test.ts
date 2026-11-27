import { type FunctionCall, FunctionType } from "@aztec-labs/aztec.js/abi"
import { AztecAddress as SdkAddress, EthAddress } from "@aztec-labs/aztec.js/addresses"
import { Contract } from "@aztec-labs/aztec.js/contracts"
import { SponsoredFeePaymentMethod } from "@aztec-labs/aztec.js/fee"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { ExecutionPayload } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { tokenBridgeHubArtifact } from "@pp/bridge-core/artifacts"
import type { Address } from "viem"
import { describe, expect, test, vi } from "vitest"
import { stageManifest } from "../capabilities"
import type { AllowListPort, AztecSendHooks } from "../ports"
import type { AztecAddress, LabelCheck, LabelPath } from "../stack-types"
import type { HeldWallet } from "../wallet/connector"
import { parseGrant } from "../wallet/grant"
import type { AztecDeps } from "./aztec"
import { stackWithdraw } from "./withdraw"

/** Set by a test to make the token's unshield carry another amount than the one confirmed. */
const unshieldOff = vi.hoisted(() => ({ by: 0n }))
vi.mock("./token-sends", async (actual) => {
	const m = await actual<typeof import("./token-sends")>()
	return {
		...m,
		spendPayloads(d: Parameters<typeof m.spendPayloads>[0]) {
			const p = m.spendPayloads(d)
			return {
				...p,
				unshield: (...[w, a, path]: Parameters<typeof p.unshield>) =>
					p.unshield(w, { ...a, amount: a.amount + unshieldOff.by }, path),
			}
		},
	}
})

const at = (n: string) => `0x${n.repeat(32)}` as AztecAddress
const [HUB, TOKEN, FPC, ME, OTHER] = [at("08"), at("09"), at("0c"), at("1c"), at("2a")]
const PAYEE = `0x${"ab".repeat(20)}` as Address
const T = { hub: HUB, token: TOKEN, sponsoredFpc: FPC }
const MANIFEST = stageManifest("2e", T)
const GRANT = parseGrant(MANIFEST, {
	granted: MANIFEST.capabilities.map((c) => (c.type === "accounts" ? { ...c, accounts: [{ item: ME }] } : c)),
})
const ACTIVE: LabelCheck = { state: "ACTIVE", path: { index: 1, depth: 1, siblings: [7n, ...Array(17).fill(0n)] } }
const sdk = (a: AztecAddress) => SdkAddress.fromStringUnsafe(a)

type Exit = {
	hub?: AztecAddress
	token?: AztecAddress
	payee?: Address
	amount?: bigint
	label?: bigint
	fpc?: AztecAddress
	extra?: boolean
	/** Fields to change on the sponsor's call, or on the exit's. */
	sponsor?: Partial<FunctionCall>
	exit?: Partial<FunctionCall>
	/** An input no call takes, added to the payload. */
	witness?: boolean
	capsule?: boolean
	hashedArgs?: boolean
}

const changed = (c: FunctionCall, patch: Partial<FunctionCall>): FunctionCall =>
	Object.assign(Object.create(Object.getPrototypeOf(c)), c, patch)

/** The hub's exit `fn` as bridge-core builds it, with any field a test wants wrong. */
async function hubExit(
	wallet: Wallet,
	fn: "exit_public" | "exit_private",
	a: { payee: Address; amount: bigint; label?: bigint; path?: LabelPath },
	w: Exit,
): Promise<ExecutionPayload> {
	const hub = Contract.at(sdk(w.hub ?? HUB), tokenBridgeHubArtifact, wallet)
	const fee = { paymentMethod: new SponsoredFeePaymentMethod(sdk(w.fpc ?? FPC)) }
	const args: unknown[] = [sdk(w.token ?? TOKEN), EthAddress.fromString(w.payee ?? a.payee), w.amount ?? a.amount]
	if (fn === "exit_private" && a.path)
		args.push(new Fr(w.label ?? a.label ?? 0n), { index: a.path.index, depth: a.path.depth, siblings: [...a.path.siblings] })
	const p = await hub.methods[fn](...args).request({ fee })
	const [sponsor, exit] = p.calls as [FunctionCall, FunctionCall]
	const calls = [changed(sponsor, w.sponsor ?? {}), changed(exit, w.exit ?? {}), ...(w.extra ? [exit] : [])]
	const one = (add: boolean | undefined, xs: unknown[]) => (add ? [{} as never] : (xs as never[]))
	return new ExecutionPayload(
		calls,
		one(w.witness, p.authWitnesses),
		one(w.capsule, p.capsules),
		one(w.hashedArgs, p.extraHashedArgs),
		p.feePayer,
	)
}

function rig(check: LabelCheck = ACTIVE, wrong?: Exit) {
	const wallet = {
		getAccounts: vi.fn(async () => [{ alias: "me", item: sdk(ME) }]),
		getChainInfo: vi.fn(async () => ({ chainId: new Fr(31337n), version: new Fr(5n) })),
		registerContract: vi.fn(async () => {}),
		sendTx: vi.fn(async (_p: ExecutionPayload) => ({ txHash: { toString: () => at("dd") } })),
	}
	const live: HeldWallet = { epoch: 3, wallet: wallet as unknown as Wallet, grant: GRANT }
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
	const allowList = {
		current: vi.fn<AllowListPort["current"]>(async () => ({
			record: { sequence: 1n, poolRoot: 9n, birthRoot: 0n, l1Block: 1n, rootTime: 1n, poolSize: 1n, birthSize: 0n },
			nowSec: 2n,
		})),
		check: vi.fn<AllowListPort["check"]>(async () => check),
	}
	const client = {
		exitPublicPayload: vi.fn((a: { payee: Address; amount: bigint }) => hubExit(live.wallet, "exit_public", a, wrong ?? {})),
		exitPrivatePayload: vi.fn((a: { payee: Address; amount: bigint; label: bigint; path: LabelPath }) =>
			hubExit(live.wallet, "exit_private", a, wrong ?? {}),
		),
	}
	const notes = vi.fn(async (_owner: AztecAddress, _label: bigint) => [5n])
	const publicBalance = vi.fn(async (_owner: AztecAddress) => 5n)
	const port = stackWithdraw({ aztec, allowList, sponsoredFpc: FPC, client, notes, publicBalance })
	return { wallet, allowList, client, notes, publicBalance, port }
}

const on = (handoff = vi.fn()): AztecSendHooks & { handoff: ReturnType<typeof vi.fn> } => ({ epoch: 3, handoff })
const screened = { payee: PAYEE, amount: 5n, label: 77n, origin: 0 } as const
const sentPayload = (r: ReturnType<typeof rig>) => r.wallet.sendTx.mock.calls[0]?.[0] as ExecutionPayload

describe("withdrawals to Ethereum", () => {
	test("the screened exit is one transaction: the sponsor, the label's checked unshield, then exit_public of the same amount", async () => {
		const r = rig()
		const hooks = on()
		await expect(r.port.unshieldAndExit(ME, screened, hooks)).resolves.toMatchObject({ status: "success" })
		const p = sentPayload(r)
		expect(p.feePayer?.toString()).toBe(FPC)
		expect(p.calls.map((c) => [c.to.toString(), c.name])).toEqual([
			[FPC, "sponsor_unconditionally"],
			[TOKEN, "unshield"],
			[HUB, "exit_public"],
		])
		expect(p.calls[1]?.args.slice(0, 5).map((a) => a.toBigInt())).toEqual([5n, 77n, 1n, 1n, 7n])
		expect(p.calls[2]?.args.map((a) => a.toBigInt())).toEqual([BigInt(TOKEN), BigInt(PAYEE), 5n])
		expect(hooks.handoff).toHaveBeenCalledOnce()
	})

	test("a payload that is not exactly what was confirmed never reaches the handoff or the allow list", async () => {
		const wrongs: [string, Exit][] = [
			["another token", { token: OTHER }],
			["another hub", { hub: OTHER }],
			["another payee", { payee: `0x${"cd".repeat(20)}` }],
			["another amount", { amount: 6n }],
			["another fee payer", { fpc: OTHER }],
			["an extra call", { extra: true }],
			["the sponsor routed as a public call", { sponsor: { type: FunctionType.PUBLIC } }],
			["another function name on the exit's selector", { exit: { name: "exit" } }],
			["a static exit call", { exit: { isStatic: true } }],
			["an exit call that hides its sender", { exit: { hideMsgSender: true } }],
			["a witness no call takes", { witness: true }],
			["a capsule no call takes", { capsule: true }],
			["hashed arguments no call takes", { hashedArgs: true }],
		]
		const all: [string, Exit][] = [...wrongs, ["another label", { label: 78n }]]
		for (const [what, wrong] of all)
			for (const send of ["exitPublic", "unshieldAndExit", "exitPrivate"] as const) {
				// Only the private exit carries a label, and only it needs the checked path before it builds.
				if (wrong.label !== undefined && send !== "exitPrivate") continue
				const r = rig(ACTIVE, wrong)
				const hooks = on()
				await expect(r.port[send](ME, screened, hooks), `${send}: ${what}`).rejects.toMatchObject({ code: "SPEND_MISMATCH" })
				expect(hooks.handoff, `${send}: ${what}`).not.toHaveBeenCalled()
				expect(r.wallet.sendTx, `${send}: ${what}`).not.toHaveBeenCalled()
				if (send !== "exitPrivate") expect(r.allowList.check, `${send}: ${what}`).not.toHaveBeenCalled()
			}
		// An exit the client built right, merged with an unshield of another amount: only the merged check sees it.
		unshieldOff.by = 1n
		try {
			const r = rig()
			const hooks = on()
			await expect(r.port.unshieldAndExit(ME, screened, hooks)).rejects.toMatchObject({ code: "SPEND_MISMATCH" })
			expect(hooks.handoff).not.toHaveBeenCalled()
			expect(r.wallet.sendTx).not.toHaveBeenCalled()
		} finally {
			unshieldOff.by = 0n
		}
	})

	test("a refused payee reads no allow list; a label the list does not hold, notes that no longer cover it, or a refused handoff send nothing", async () => {
		const refused = rig()
		refused.client.exitPublicPayload.mockRejectedValue(Object.assign(new Error("payee"), { code: "SPEND_MISMATCH" }))
		await expect(refused.port.unshieldAndExit(ME, screened, on())).rejects.toMatchObject({ code: "SPEND_MISMATCH" })
		expect(refused.allowList.check).not.toHaveBeenCalled()
		const absent = rig({ state: "ABSENT" })
		await expect(absent.port.unshieldAndExit(ME, screened, on())).rejects.toMatchObject({ code: "LABEL_ABSENT" })
		const spent = rig()
		spent.notes.mockResolvedValue([4n])
		const late = on()
		await expect(spent.port.unshieldAndExit(ME, screened, late)).rejects.toMatchObject({ code: "OVER_NOTE_CAP" })
		expect(spent.notes).toHaveBeenCalledWith(ME, screened.label)
		// The notes are read after the allow-list check.
		expect(spent.notes.mock.invocationCallOrder[0]).toBeGreaterThan(spent.allowList.check.mock.invocationCallOrder[0] ?? 0)
		expect(late.handoff).not.toHaveBeenCalled()
		const moved = rig()
		const hooks = on(
			vi.fn(() => {
				throw new Error("the page's account changed")
			}),
		)
		await expect(moved.port.unshieldAndExit(ME, screened, hooks)).rejects.toThrow("the page's account changed")
		for (const r of [refused, absent, spent, moved]) expect(r.wallet.sendTx).not.toHaveBeenCalled()
	})

	test("the private exit is the sponsor then exit_private, with the confirmed payee, amount, label and checked path", async () => {
		const r = rig()
		const hooks = on()
		await expect(r.port.exitPrivate(ME, screened, hooks)).resolves.toMatchObject({ status: "success" })
		expect(r.client.exitPrivatePayload).toHaveBeenCalledWith({ payee: PAYEE, amount: 5n, label: 77n, path: ACTIVE.path })
		const p = sentPayload(r)
		expect(p.feePayer?.toString()).toBe(FPC)
		expect(p.calls.map((c) => [c.to.toString(), c.name])).toEqual([
			[FPC, "sponsor_unconditionally"],
			[HUB, "exit_private"],
		])
		expect(p.calls[1]?.args.slice(0, 7).map((a) => a.toBigInt())).toEqual([BigInt(TOKEN), BigInt(PAYEE), 5n, 77n, 1n, 1n, 7n])
		expect(hooks.handoff).toHaveBeenCalledOnce()
	})

	test("the private exit builds nothing for a label the list does not hold, and sends nothing once its notes no longer cover it", async () => {
		const absent = rig({ state: "ABSENT" })
		await expect(absent.port.exitPrivate(ME, screened, on())).rejects.toMatchObject({ code: "LABEL_ABSENT" })
		expect(absent.client.exitPrivatePayload).not.toHaveBeenCalled()
		const spent = rig()
		spent.notes.mockResolvedValue([4n])
		const late = on()
		await expect(spent.port.exitPrivate(ME, screened, late)).rejects.toMatchObject({ code: "OVER_NOTE_CAP" })
		expect(spent.notes).toHaveBeenCalledWith(ME, screened.label)
		expect(late.handoff).not.toHaveBeenCalled()
		for (const r of [absent, spent]) expect(r.wallet.sendTx).not.toHaveBeenCalled()
	})

	test("the public row's withdraw is exit_public alone, paid by the SponsoredFPC, and refuses a public balance spent since the form", async () => {
		const r = rig()
		await r.port.exitPublic(ME, { payee: PAYEE, amount: 5n }, on())
		expect(sentPayload(r).calls.map((c) => c.name)).toEqual(["sponsor_unconditionally", "exit_public"])
		expect(r.allowList.check).not.toHaveBeenCalled()
		const spent = rig()
		spent.publicBalance.mockResolvedValue(4n)
		const hooks = on()
		await expect(spent.port.exitPublic(ME, { payee: PAYEE, amount: 5n }, hooks)).rejects.toMatchObject({ code: "OVER_PUBLIC_BALANCE" })
		expect(spent.publicBalance).toHaveBeenCalledWith(ME)
		expect(hooks.handoff).not.toHaveBeenCalled()
		expect(spent.wallet.sendTx).not.toHaveBeenCalled()
	})
})
