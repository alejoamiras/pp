import { parseEventLogs } from "viem"
import { describe, expect, it } from "vitest"
import { sponsoredFpcAddress } from "../../../src/client/payload"
import { PROCESSOR_PORTAL_ABI } from "../../../src/factory-abi"
import { blockFees, feeJuice, feeJuiceAt, labelBalance, send, sender } from "./support/actors"
import { exitKit, freshPayee } from "./support/exit-kit"

const k = exitKit("path")

describe("path", () => {
	it("P1 bridges 70 of 100, claims it, ragequits it as one exact chunk, and settles exactly 70 under the pool label", async () => {
		await k.timed("P1", async () => {
			const { session, client, holder, label } = await k.claimed(100n, [70n])
			const dev = k.dev()
			expect(await labelBalance(dev, holder.address, label)).toBe(70n)
			expect(await feeJuice(dev, holder.address)).toBe(0n)

			const payee = freshPayee()
			const burn = await send(dev, holder.address, await client.ragequitPayload({ payee, amount: 70n, label }))
			const block = Number(burn.blockNumber)
			const fees = await blockFees(dev, block)
			expect(fees).toContain(burn.transactionFee)
			const fpc = await sponsoredFpcAddress()
			expect((await feeJuiceAt(dev, fpc, block - 1)) - (await feeJuiceAt(dev, fpc, block))).toBe(fees.reduce((a, b) => a + b, 0n))
			expect(await feeJuice(dev, holder.address)).toBe(0n)
			expect(await labelBalance(dev, holder.address, label)).toBe(0n)
			// Recovery reads consumption, not balance: the burned note's bridge stays claimed.
			expect(await client.recover(session, holder.address)).toEqual([])

			const [ticket, ...rest] = await client.exitTickets({ payee })
			expect(rest).toEqual([])
			expect(ticket).toMatchObject({ kind: "ragequit", payee, amount: 70n, label, l2TxHash: burn.txHash.toString() })
			await k.until(client, ticket!, "ready")
			const w = await k.witness(ticket!)
			const tx = await client.settle(ticket!, await sender(k.m))
			const receipt = await k.chain.waitForTransactionReceipt({ hash: tx })
			const [settled] = parseEventLogs({ abi: PROCESSOR_PORTAL_ABI, eventName: "ExitSettled", logs: receipt.logs })
			expect(settled?.args).toEqual({ payee, amount: 70n, label, epoch: w!.epoch, leafId: w!.leafId })
			expect(await k.balanceOf(payee)).toBe(70n)
			expect(await client.exitStatus(ticket!)).toBe("settled")
		})
	})
})
