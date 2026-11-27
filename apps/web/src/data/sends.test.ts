import type { Address } from "viem"
import { describe, expect, test } from "vitest"
import { bindAztecSend, bindL1Send, type SendContext } from "./sends"
import type { AztecAddress } from "./stack-types"

const ME = `0x${"1c".repeat(32)}` as AztecAddress
const SENDER: Address = "0x00000000000000000000000000000000000000b2"
const OTHER: Address = "0x00000000000000000000000000000000000000c3"

describe("a send's binding", () => {
	test("an Aztec send keeps the connection that listed its account at the confirm, and none refuses at once", () => {
		let ctx: SendContext = { account: null, chainId: null, epoch: null, aztecAccounts: [] }
		const live = () => ctx
		expect(() => bindAztecSend(live, ME)).toThrow(expect.objectContaining({ code: "CONTEXT_CHANGED" }))
		ctx = { ...ctx, epoch: 3, aztecAccounts: [ME] }
		const on = bindAztecSend(live, ME)
		expect(on.epoch).toBe(3)
		on.handoff()
		for (const later of [{ epoch: 4 }, { aztecAccounts: [] }]) {
			ctx = { ...ctx, epoch: 3, aztecAccounts: [ME], ...later }
			expect(() => on.handoff()).toThrow(expect.objectContaining({ code: "CONTEXT_CHANGED" }))
		}
	})

	test("an Ethereum send's handoff refuses once its sender or chain is no longer selected, and says it refused", () => {
		for (const later of [{ account: OTHER }, { account: null }, { chainId: 1 }]) {
			let ctx: SendContext = { account: SENDER, chainId: 31337, epoch: null, aztecAccounts: [] }
			const on = bindL1Send(() => ctx, SENDER, 31337)
			on.handoff()
			expect(on.refused()).toBe(false)
			ctx = { ...ctx, ...later }
			expect(() => on.handoff()).toThrow(expect.objectContaining({ code: "CONTEXT_CHANGED" }))
			expect(on.refused()).toBe(true)
		}
	})
})
