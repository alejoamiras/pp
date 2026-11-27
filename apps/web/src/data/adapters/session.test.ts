import type { BridgeSession, openBridgeSession } from "@pp/bridge-core"
import { secretDerivationTypedData } from "@pp/pool-client"
import { type Address, type Hash, type Hex, TransactionNotFoundError, TransactionReceiptNotFoundError } from "viem"
import { describe, expect, test, vi } from "vitest"
import type { StackManifestJson } from "../../build/target"
import type { DelegatingProver } from "./prover"
import { l1TxState, type SessionDeps, stackSessions } from "./session"

const A20 = (n: string) => `0x${n.repeat(20)}`
const A32 = (n: string) => `0x${n.repeat(32)}`
const OWNER: Address = "0x00000000000000000000000000000000000000a1"
const SIGNATURE: Hex = `0x${"5a".repeat(65)}`
const TX: Hash = `0x${"ab".repeat(32)}`

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
	bridge: { factory: A20("06"), portal: A20("07"), hub: A32("08"), token: A32("09"), registry: A32("0a"), deployBlock: "34" },
}

const missingReceipt = () => Promise.reject(new TransactionReceiptNotFoundError({ hash: TX }))
const missingTx = () => Promise.reject(new TransactionNotFoundError({ hash: TX }))

describe("the stack session", () => {
	test("signs the derivation request, opens the bridge session with the page's prover and own origin, and reads notes through it", async () => {
		const prover = { cancel: vi.fn() } as unknown as DelegatingProver
		const artifacts: SessionDeps["artifacts"] = { kind: "gateway", urls: ["http://127.0.0.1:5173"] }
		const notes = [{ commitment: 1n }]
		const open = vi.fn(async () => ({ l1Address: OWNER, pool: { notes: async () => notes } }) as unknown as BridgeSession)
		const sign = vi.fn(async () => SIGNATURE)
		const reads = { getTransaction: missingTx, getTransactionReceipt: missingReceipt } as unknown as SessionDeps["reads"]
		const sessions = stackSessions({ manifest: MANIFEST, reads, prover, artifacts, open: open as typeof openBridgeSession })

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
		for (const call of [
			session.records(),
			session.submit({} as never, {} as never, {} as never),
			session.claim({} as never, {} as never),
		])
			await expect(call).rejects.toMatchObject({ code: "BRIDGE_UNAVAILABLE" })
		session.cancelProve()
		expect(prover.cancel).toHaveBeenCalledOnce()
	})

	test("a hash is mined with a receipt, pending with only a transaction, unknown with neither; an RPC failure is no answer", async () => {
		const found = () => Promise.resolve({})
		const state = (getTransactionReceipt: () => Promise<unknown>, getTransaction: () => Promise<unknown>) =>
			l1TxState({ getTransactionReceipt, getTransaction } as unknown as SessionDeps["reads"], TX)
		await expect(state(found, missingTx)).resolves.toBe("mined")
		await expect(state(missingReceipt, found)).resolves.toBe("pending")
		await expect(state(missingReceipt, missingTx)).resolves.toBe("unknown")
		await expect(state(() => Promise.reject(new Error("fetch failed")), found)).rejects.toThrow("fetch failed")
	})
})
