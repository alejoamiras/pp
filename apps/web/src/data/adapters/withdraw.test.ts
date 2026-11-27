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
import type { AztecAddress, LabelCheck } from "../stack-types"
import type { HeldWallet } from "../wallet/connector"
import { parseGrant } from "../wallet/grant"
import type { AztecDeps } from "./aztec"
import { stackWithdraw } from "./withdraw"

const at = (n: string) => `0x${n.repeat(32)}` as AztecAddress
const [HUB, TOKEN, FPC, ME, OTHER] = [at("08"), at("09"), at("0c"), at("1c"), at("2a")]
const PAYEE = `0x${"ab".repeat(20)}` as Address
const T = { hub: HUB, token: TOKEN, sponsoredFpc: FPC }
const MANIFEST = stageManifest("2d", T)
const GRANT = parseGrant(MANIFEST, {
	granted: MANIFEST.capabilities.map((c) => (c.type === "accounts" ? { ...c, accounts: [{ item: ME }] } : c)),
})
const ACTIVE: LabelCheck = { state: "ACTIVE", path: { index: 1, depth: 1, siblings: [7n, ...Array(17).fill(0n)] } }
const sdk = (a: AztecAddress) => SdkAddress.fromStringUnsafe(a)

type Exit = { hub?: AztecAddress; token?: AztecAddress; amount?: bigint; fpc?: AztecAddress; extra?: boolean }

/** `exit_public` as bridge-core builds it, with any field a test wants wrong. */
async function exitPayload(wallet: Wallet, a: { payee: Address; amount: bigint }, w: Exit = {}): Promise<ExecutionPayload> {
	const hub = Contract.at(sdk(w.hub ?? HUB), tokenBridgeHubArtifact, wallet)
	const fee = { paymentMethod: new SponsoredFeePaymentMethod(sdk(w.fpc ?? FPC)) }
	const p = await hub.methods.exit_public(sdk(w.token ?? TOKEN), EthAddress.fromString(a.payee), w.amount ?? a.amount).request({ fee })
	if (!w.extra) return p
	return new ExecutionPayload([...p.calls, p.calls[1] as never], p.authWitnesses, p.capsules, p.extraHashedArgs, p.feePayer)
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
			record: { sequence: 1n, poolRoot: 9n, birthRoot: 0n, l1Block: 1n, rootTime: 1n },
			nowSec: 2n,
		})),
		check: vi.fn<AllowListPort["check"]>(async () => check),
	}
	const client = { exitPublicPayload: vi.fn((a: { payee: Address; amount: bigint }) => exitPayload(live.wallet, a, wrong)) }
	const notes = vi.fn(async (_owner: AztecAddress, _label: bigint) => [5n])
	return { wallet, allowList, client, notes, port: stackWithdraw({ aztec, allowList, sponsoredFpc: FPC, client, notes }) }
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
			["another amount", { amount: 6n }],
			["another fee payer", { fpc: OTHER }],
			["an extra call", { extra: true }],
		]
		for (const [what, wrong] of wrongs)
			for (const send of ["exitPublic", "unshieldAndExit"] as const) {
				const r = rig(ACTIVE, wrong)
				const hooks = on()
				const sent = send === "exitPublic" ? r.port.exitPublic(ME, screened, hooks) : r.port.unshieldAndExit(ME, screened, hooks)
				await expect(sent, `${send}: ${what}`).rejects.toMatchObject({ code: "SPEND_MISMATCH" })
				expect(hooks.handoff, `${send}: ${what}`).not.toHaveBeenCalled()
				expect(r.wallet.sendTx, `${send}: ${what}`).not.toHaveBeenCalled()
				expect(r.allowList.check, `${send}: ${what}`).not.toHaveBeenCalled()
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

	test("the public row's withdraw is exit_public alone, paid by the SponsoredFPC", async () => {
		const r = rig()
		await r.port.exitPublic(ME, { payee: PAYEE, amount: 5n }, on())
		expect(sentPayload(r).calls.map((c) => c.name)).toEqual(["sponsor_unconditionally", "exit_public"])
		expect(r.allowList.check).not.toHaveBeenCalled()
	})
})
