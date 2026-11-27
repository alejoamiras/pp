import { computeFeePayerBalanceLeafSlot } from "@aztec-labs/protocol-contracts/fee-juice"
import { type Hex, readRootRecord } from "@pp/label-paths"
import { describe, expect, it } from "vitest"
import { labelledTokenArtifact, tokenBridgeHubArtifact } from "../../../src/artifacts"
import { sponsoredFpcAddress } from "../../../src/client/payload"
import { publicCallsOf, selectorOf } from "../public-calls"
import { captureSentTxs } from "../wallet-internals"
import { labelBalance, publicBalance, send, sender } from "./support/actors"
import { exitKit, freshPayee } from "./support/exit-kit"
import { poolPath } from "./support/pool-path"

const k = exitKit("private-exit")

describe("private exit", () => {
	it("X2 exits 25 of a claimed 40 through the client with no holder in its public effects, and settles exactly 25", async () => {
		await k.timed("X2", async () => {
			const { client, holder, label } = await k.claimed(100n, [40n])
			const dev = k.dev()
			const hub = k.m.bridge.hub.toLowerCase()
			const token = k.m.bridge.token.toLowerCase()
			// The suite runs one file at a time and every approval is an actor's own call, so no other
			// label is approved between this read and the exit's inclusion.
			const path = await poolPath(k.m, dev, label)
			const payee = freshPayee()
			const sent = captureSentTxs(dev.wallet)
			const burn = await send(dev, holder.address, await client.exitPrivatePayload({ payee, amount: 25n, label, path }))
			const tx = sent.find((t) => t.getTxHash().toString() === burn.txHash.toString())
			if (!tx) throw new Error("the exit's submission was not captured")

			// The submission: the sponsor pays, and the only public calls are the token's root re-check and
			// the hub's ticket, each sent by its own contract.
			expect(tx.data.feePayer.equals(await sponsoredFpcAddress())).toBe(true)
			const anchor = tx.data.constants.anchorBlockHeader.globalVariables.blockNumber
			const record = await readRootRecord({ aztecNode: k.m.aztecNode, registry: k.m.bridge.registry as Hex, at: Number(anchor) })
			const calls = publicCallsOf(tx).map((c) => ({ ...c, to: c.to.toLowerCase(), from: c.from.toLowerCase() }))
			expect(calls).toEqual([
				{
					to: token,
					from: token,
					calldata: [
						await selectorOf(labelledTokenArtifact, "finish_checked_burn"),
						record.poolRoot,
						record.rootTime,
						record.birthRoot,
						record.rootTime,
					],
				},
				{
					to: hub,
					from: hub,
					calldata: [await selectorOf(tokenBridgeHubArtifact, "_exit_ticket"), BigInt(token), BigInt(payee), 25n],
				},
			])
			const holderWord = holder.address.toBigInt()
			for (const c of calls) expect([BigInt(c.from), ...c.calldata]).not.toContain(holderWord)

			// The landed effect: the ticket is the only log, and the fee payer's balance the only public write.
			const effect = await dev.node.getTxEffect(burn.txHash)
			if (!effect) throw new Error("the node has no effect for the exit")
			expect(effect.data.publicLogs.map((l) => l.contractAddress.toString().toLowerCase())).toEqual([hub])
			for (const l of effect.data.publicLogs) expect(l.fields.map((f) => f.toBigInt())).not.toContain(holderWord)
			const feeLeaf = await computeFeePayerBalanceLeafSlot(tx.data.feePayer)
			expect(effect.data.publicDataWrites.length).toBeGreaterThan(0)
			expect(effect.data.publicDataWrites.every((w) => w.leafSlot.equals(feeLeaf))).toBe(true)
			expect(await labelBalance(dev, holder.address, label)).toBe(15n)
			expect(await publicBalance(dev, holder.address)).toBe(0n)

			const [ticket, ...rest] = await client.exitTickets({ payee })
			expect(rest).toEqual([])
			expect(ticket).toMatchObject({ kind: "public", payee, amount: 25n, l2TxHash: burn.txHash.toString() })
			await k.until(client, ticket!, "ready")
			await client.settle(ticket!, await sender(k.m))
			expect(await k.balanceOf(payee)).toBe(25n)
			expect(await client.exitStatus(ticket!)).toBe("settled")
		})
	})
})
