import { AztecAddress as SdkAddress } from "@aztec-labs/aztec.js/addresses"
import { Fr } from "@aztec-labs/aztec.js/fields"
import type { ExecutionPayload } from "@aztec-labs/aztec.js/tx"
import type { Wallet } from "@aztec-labs/aztec.js/wallet"
import { labelledTokenArtifact, tokenBridgeHubArtifact } from "@pp/bridge-core/artifacts"
import { describe, expect, test, vi } from "vitest"
import { stageManifest } from "../capabilities"
import type { Hex } from "viem"
import { ProviderError } from "../errors"
import type { AztecAddress } from "../stack-types"
import type { HeldWallet } from "../wallet/connector"
import { parseGrant } from "../wallet/grant"
import { type AztecDeps, entries, grantedPayload, noteValues, readReceipt, registerScoped, sendThroughWallet } from "./aztec"

const at = (n: string) => `0x${n.repeat(32)}` as AztecAddress
const [HUB, TOKEN, FPC, ME, STRANGER] = [at("08"), at("09"), at("0c"), at("1c"), at("2d")]
const MANIFEST = stageManifest("2a", { hub: HUB, token: TOKEN, sponsoredFpc: FPC })

function grant(contracts = [HUB, TOKEN]) {
	return parseGrant(MANIFEST, {
		granted: MANIFEST.capabilities.map((c) =>
			c.type === "accounts" ? { ...c, accounts: [{ item: ME }] } : c.type === "contracts" ? { ...c, contracts } : c,
		),
	})
}

const receipt = (ok: boolean) => ({
	status: "proposed",
	isPending: () => false,
	isDropped: () => false,
	isMined: () => true,
	hasExecutionSucceeded: () => ok,
	blockNumber: 17,
})

function rig(o: { contracts?: AztecAddress[]; served?: (a: { toString(): string }) => unknown; ok?: boolean } = {}) {
	const wallet = {
		getAccounts: vi.fn(async () => [{ alias: "me", item: SdkAddress.fromStringUnsafe(ME) }]),
		getChainInfo: vi.fn(async () => ({ chainId: new Fr(31337n), version: new Fr(5n) })),
		registerContract: vi.fn(async () => {}),
		sendTx: vi.fn(async () => ({ txHash: { toString: () => at("dd") } })),
	}
	const held: HeldWallet = { epoch: 3, wallet: wallet as unknown as Wallet, grant: grant(o.contracts) }
	let live: HeldWallet | null = held
	const node = {
		getContract: vi.fn(async (a: { toString(): string }) => (o.served ? o.served(a) : { address: a })),
		getTxReceipt: vi.fn(async () => receipt(o.ok ?? true)),
		getNodeInfo: vi.fn(async () => ({ l1ChainId: 31337, rollupVersion: 5 })),
	}
	const d: AztecDeps = { deployment: { hub: HUB, token: TOKEN, chainId: 31337 }, node: node as never, current: () => live }
	return { d, wallet, node, held, drop: () => (live = null) }
}

const payload = (...calls: [AztecAddress, string][]) =>
	({ calls: calls.map(([to, name]) => ({ to, name })) }) as unknown as ExecutionPayload
const CLAIM = payload([FPC, "sponsor_unconditionally"], [HUB, "claim_from_pool"])

describe("the Aztec adapter", () => {
	test("keeps the wallet's hash as unconfirmed when the outcome cannot be read after the send", async () => {
		const r = rig()
		r.node.getTxReceipt.mockRejectedValue(new Error("node down"))
		const sent = sendThroughWallet(r.d, { epoch: 3, from: ME, payload: CLAIM, contracts: ["hub", "token"], handoff: () => {} })
		await expect(sent).resolves.toEqual({ txHash: at("dd"), status: "unconfirmed" })
		expect(r.wallet.sendTx).toHaveBeenCalledTimes(1)
	}, 10_000)

	test("reads a wallet send that throws past the handoff as unconfirmed with no hash, and the wallet's no as a refusal", async () => {
		const r = rig()
		const send = () => sendThroughWallet(r.d, { epoch: 3, from: ME, payload: CLAIM, contracts: ["hub", "token"], handoff: () => {} })
		r.wallet.sendTx.mockRejectedValueOnce(new Error("the wallet's socket closed"))
		await expect(send()).resolves.toEqual({ status: "unconfirmed" })
		r.wallet.sendTx.mockRejectedValueOnce(new ProviderError(4001, "User rejected the request."))
		await expect(send()).rejects.toMatchObject({ code: 4001 })
		const reject = { code: 4001, message: "User rejected", data: { walletErrorCode: "USER_REJECTED", walletTraceId: "1" } }
		r.wallet.sendTx.mockRejectedValueOnce(new Error(JSON.stringify(reject)))
		await expect(send()).rejects.toThrow(/USER_REJECTED/)
		// Wording is no proof past the handoff.
		r.wallet.sendTx.mockRejectedValueOnce(new Error("User rejected the request"))
		await expect(send()).resolves.toEqual({ status: "unconfirmed" })
	})

	test("reads its own transaction's receipt as included, reverted at its block, or pending while not mined; another's is no answer", async () => {
		const r = rig()
		const hash = at("1d") as Hex
		const of = (ok: boolean, h: string = hash) => ({ ...receipt(ok), txHash: { toString: () => h } })
		r.node.getTxReceipt.mockResolvedValueOnce(of(true))
		await expect(readReceipt(r.d.node, hash)).resolves.toEqual({ status: "success" })
		r.node.getTxReceipt.mockResolvedValueOnce(of(false))
		await expect(readReceipt(r.d.node, hash)).resolves.toEqual({ status: "reverted", block: 17 })
		r.node.getTxReceipt.mockResolvedValueOnce({ ...of(true), isMined: () => false, isPending: () => true })
		await expect(readReceipt(r.d.node, hash)).resolves.toEqual({ status: "pending" })
		r.node.getTxReceipt.mockResolvedValueOnce({ ...of(false), blockNumber: undefined } as never)
		await expect(readReceipt(r.d.node, hash)).rejects.toMatchObject({ code: "RPC_INCONSISTENT" })
		r.node.getTxReceipt.mockResolvedValueOnce(of(true, at("1e")))
		await expect(readReceipt(r.d.node, hash)).rejects.toMatchObject({ code: "RPC_INCONSISTENT" })
	})

	test("keeps only the wallet's note values a ragequit can burn: positive u128s", () => {
		expect(noteValues([5n, 0n, 0, -1n, 1n << 128n, "7", 3])).toEqual([5n, 3n])
	})

	test("teaches a fresh wallet the app's granted contracts once each, and nothing it was not granted or the node does not serve", async () => {
		const r = rig()
		await registerScoped(r.d, r.held, ["hub", "token"])
		await registerScoped(r.d, r.held, ["token", "hub"])
		const taught = r.wallet.registerContract.mock.calls as unknown as [{ address: { toString(): string } }, unknown][]
		expect(taught.map(([i, artifact]) => [i.address.toString(), artifact])).toEqual([
			[HUB, tokenBridgeHubArtifact],
			[TOKEN, labelledTokenArtifact],
		])

		const narrow = rig({ contracts: [HUB] })
		await expect(registerScoped(narrow.d, narrow.held, ["token"])).rejects.toMatchObject({ code: "NOT_GRANTED" })
		const forged = rig({ served: () => ({ address: STRANGER }) })
		await expect(registerScoped(forged.d, forged.held, ["hub"])).rejects.toMatchObject({ code: "DEPLOYMENT_MISMATCH" })
		expect(narrow.wallet.registerContract).not.toHaveBeenCalled()
		expect(forged.wallet.registerContract).not.toHaveBeenCalled()
	})

	test("refuses before the handoff a send whose connection is gone, whose account or call was not granted, or whose handoff throws", async () => {
		const send = (r: ReturnType<typeof rig>, over: Partial<Parameters<typeof sendThroughWallet>[1]> = {}) =>
			sendThroughWallet(r.d, { epoch: 3, from: ME, payload: CLAIM, contracts: ["hub", "token"], handoff: () => {}, ...over })
		const cases: [ReturnType<typeof rig>, Partial<Parameters<typeof sendThroughWallet>[1]>, string][] = [
			[rig(), { epoch: 4 }, "CONTEXT_CHANGED"],
			[rig(), { from: STRANGER }, "RECIPIENT_NOT_IN_WALLET"],
			[rig(), { payload: payload([FPC, "sponsor_unconditionally"], [TOKEN, "transfer_public"]) }, "NOT_GRANTED"],
		]
		for (const [r, over, code] of cases) {
			const handoff = vi.fn()
			await expect(send(r, { handoff, ...over })).rejects.toMatchObject({ code })
			expect(handoff).not.toHaveBeenCalled()
			expect(r.wallet.sendTx).not.toHaveBeenCalled()
		}
		const held = rig()
		await expect(
			send(held, {
				handoff: () => {
					throw new Error("context changed")
				},
			}),
		).rejects.toThrow("context changed")
		expect(held.wallet.sendTx).not.toHaveBeenCalled()
	})

	test("reads the wallet's accounts last, so a recipient it drops while the node answers reaches no sendTx", async () => {
		const r = rig()
		let asked = () => {}
		const nodeAsked = new Promise<void>((res) => (asked = res))
		let answer = () => {}
		r.node.getNodeInfo.mockImplementationOnce(
			() =>
				new Promise((res) => {
					answer = () => res({ l1ChainId: 31337, rollupVersion: 5 })
					asked()
				}),
		)
		const sending = sendThroughWallet(r.d, { epoch: 3, from: ME, payload: CLAIM, contracts: ["hub", "token"], handoff: () => {} })
		await nodeAsked
		r.wallet.getAccounts.mockResolvedValue([])
		answer()
		await expect(sending).rejects.toMatchObject({ code: "RECIPIENT_NOT_IN_WALLET" })
		expect(r.wallet.sendTx).not.toHaveBeenCalled()
	})

	test("refuses a send whose node and wallet both moved off the deployment's chain, or whose wallet lists a malformed account", async () => {
		const send = (r: ReturnType<typeof rig>) =>
			sendThroughWallet(r.d, { epoch: 3, from: ME, payload: CLAIM, contracts: ["hub", "token"], handoff: () => {} })
		const moved = rig()
		moved.node.getNodeInfo.mockResolvedValue({ l1ChainId: 1, rollupVersion: 5 })
		moved.wallet.getChainInfo.mockResolvedValue({ chainId: new Fr(1n), version: new Fr(5n) })
		await expect(send(moved)).rejects.toMatchObject({ code: "CONTEXT_CHANGED" })
		for (const chain of [{}, { chainId: {}, version: new Fr(5n) }, { chainId: { toBigInt: () => 31337 }, version: new Fr(5n) }, null]) {
			const garbled = rig()
			garbled.wallet.getChainInfo.mockResolvedValue(chain as never)
			await expect(send(garbled)).rejects.toMatchObject({ code: "CONTEXT_CHANGED" })
			expect(garbled.wallet.sendTx).not.toHaveBeenCalled()
		}
		const hostile = {
			toString() {
				throw new Error("no text")
			},
		}
		for (const listed of [[null], [{}], [{ alias: "x", item: null }], [{ item: Object.create(null) }], [{ item: hostile }], null]) {
			const odd = rig()
			odd.wallet.getAccounts.mockResolvedValue(listed as never)
			await expect(send(odd)).rejects.toMatchObject({ code: "RECIPIENT_NOT_IN_WALLET" })
			expect(odd.wallet.sendTx).not.toHaveBeenCalled()
		}
		expect(moved.wallet.sendTx).not.toHaveBeenCalled()
	})

	test("a payload with no calls is never granted, and a page with a negative length reads as empty", () => {
		expect(grantedPayload(rig().held, "transaction", payload())).toBe(false)
		expect(grantedPayload(rig().held, "transaction", CLAIM)).toBe(true)
		expect(entries({ storage: [1, 2, 3], len: -1n })).toEqual([])
		expect(entries({ storage: [1, 2, 3], len: 2n })).toEqual([1, 2])
	})

	test("answers a sent transaction's hash with its outcome, and a revert with the block it landed in", async () => {
		const send = (r: ReturnType<typeof rig>) =>
			sendThroughWallet(r.d, { epoch: 3, from: ME, payload: CLAIM, contracts: ["hub", "token"], handoff: () => {} })
		await expect(send(rig())).resolves.toEqual({ txHash: at("dd"), status: "success" })
		await expect(send(rig({ ok: false }))).resolves.toEqual({ txHash: at("dd"), status: "reverted", block: 17 })
	})
})
