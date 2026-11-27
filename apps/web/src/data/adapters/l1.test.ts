import type { Address, Hash } from "viem"
import { describe, expect, test } from "vitest"
import type { Attempt } from "../ports"
import { type InjectedWallet, stackL1 } from "./l1"

const TARGET = { l1ChainId: 31337, l1RpcUrl: "http://127.0.0.1:8545" }
const SENDER: Address = "0x00000000000000000000000000000000000000b2"
const PORTAL: Address = "0x00000000000000000000000000000000000000d4"
const TX: Hash = `0x${"ab".repeat(32)}`

/** A wallet on `chainId` that logs every request and each send's `from`, and answers a send with `TX`. */
function wallet(chainId: number) {
	const methods: string[] = []
	const from: unknown[] = []
	const w: InjectedWallet = {
		async request({ method, params }) {
			methods.push(method)
			if (method === "eth_chainId") return `0x${chainId.toString(16)}`
			if (method === "eth_sendTransaction") {
				from.push((params as [{ from: unknown }])[0].from)
				return TX
			}
			throw Object.assign(new Error(`${method} unexpected`), { code: 4200 })
		},
	}
	return { w, methods, from }
}

const attempt = { sender: SENDER } as Attempt

describe("the stack's Ethereum port", () => {
	test("a spend sends from the attempt's sender on the target chain only, and the hook hears the wallet's hash", async () => {
		const sent: Hash[] = []
		const on = wallet(TARGET.l1ChainId)
		const client = stackL1(TARGET, on.w).spendWallet(attempt, () => {}, { sent: (h) => sent.push(h) })
		await expect(client.sendTransaction({ to: PORTAL, value: 0n })).resolves.toBe(TX)
		expect(sent).toEqual([TX])
		expect(on.from).toEqual([SENDER])

		const elsewhere = wallet(1)
		const wrongChain = stackL1(TARGET, elsewhere.w).spendWallet(attempt, () => {}, { sent: (h) => sent.push(h) })
		await expect(wrongChain.sendTransaction({ to: PORTAL, value: 0n })).rejects.toThrow(/chain/i)
		const changed = stackL1(TARGET, wallet(TARGET.l1ChainId).w).spendWallet(
			attempt,
			() => {
				throw new Error("account switched")
			},
			{ sent: (h) => sent.push(h) },
		)
		await expect(changed.sendTransaction({ to: PORTAL, value: 0n })).rejects.toMatchObject({
			details: expect.stringMatching(/nothing was sent/),
		})
		expect(elsewhere.methods).not.toContain("eth_sendTransaction")
		expect(sent).toEqual([TX])
	})

	test("without an injected wallet the page lists no account and refuses anything that needs one", async () => {
		const l1 = stackL1(TARGET, undefined)
		await expect(l1.accounts()).resolves.toEqual([])
		await expect(l1.chainId()).rejects.toMatchObject({ code: "NO_SENDER" })
	})
})
