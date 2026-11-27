import { describe, expect, it } from "vitest"
import type { BridgeClient } from "../../../src/client/bridge-client"
import type { ExitTicket } from "../../../src/client/types"
import { sender } from "./support/actors"
import { exitKit, freshPayee } from "./support/exit-kit"

const k = exitKit("exit")
const payee = freshPayee()
let client: BridgeClient
let b: ExitTicket[] = []

describe("exit", () => {
	it("E1 a ragequit settles on beats alone, and an identical exit in a later epoch stays ready while it does", async () => {
		await k.timed("E1", async () => {
			const fx = await k.claimed(100n, [10n, 10n, 10n])
			client = fx.client
			const ra = await k.ragequit(fx.holder, payee, fx.label, [10n])
			const [a, ...none] = await client.exitTickets({ payee })
			expect(none).toEqual([])
			// No outside Ethereum transaction until the ticket is ready: the heartbeat's beats alone prove it.
			const seen = await k.until(client, a!, "ready")
			console.log(`[exit] E1 ticket a read ${seen.join(" → ")} from its first live read`)

			await k.intoLaterEpoch(Number(ra.epochNumber))
			const rb = await k.ragequit(fx.holder, payee, fx.label, [10n, 10n])
			expect(Number(rb.epochNumber)).toBeGreaterThan(Number(ra.epochNumber))
			b = (await client.exitTickets({ payee })).filter((t) => t.l2TxHash === rb.txHash.toString())
			const { l2TxHash: _, messageIndexInTx: __, ...content } = a!
			expect(b.map(({ l2TxHash: _t, messageIndexInTx: _i, ...rest }) => rest)).toEqual([content, content])
			await k.until(client, b[0]!, "ready")

			await client.settle(a!, await sender(k.m))
			expect(await client.exitStatus(a!)).toBe("settled")
			expect(await client.exitStatus(b[0]!)).toBe("ready")
			expect(await k.balanceOf(payee)).toBe(10n)
		})
	})

	it("E3 the two identical exits of one transaction take message indices 0 and 1 and both settle", async () => {
		await k.timed("E3", async () => {
			expect(b.map((t) => t.messageIndexInTx)).toEqual([0, 1])
			const l1 = await sender(k.m)
			const txs = []
			for (const t of b) {
				await k.until(client, t, "ready")
				txs.push(await client.settle(t, l1))
			}
			expect(new Set(txs).size).toBe(2)
			for (const t of b) expect(await client.exitStatus(t)).toBe("settled")
			expect(await k.balanceOf(payee)).toBe(30n)
		})
	})
})
